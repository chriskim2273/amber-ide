import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { lstat, link, open, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { readSafeTextFile } from './safeFileReader'

const execFile = promisify(execFileCallback)
const LOCK_PROTOCOL = 'amber-layout-lock-v1'
const LOCK_RECORD_MAX_BYTES = 4096
const LOCK_WAIT_MS = 2_000

export interface LayoutLockRecord { pid: number; start: string; token: string }
interface LockSnapshot { record: LayoutLockRecord | null; text: string; stat: Stats }

export function formatLayoutLockRecord(record: LayoutLockRecord): string {
  return `${LOCK_PROTOCOL}\npid=${record.pid}\nstart=${record.start}\ntoken=${record.token}\n`
}

export function parseLayoutLockRecord(text: string): LayoutLockRecord | null {
  const lines = text.split('\n')
  if (lines.at(-1) !== '' || lines[0] !== LOCK_PROTOCOL) return null
  const values = new Map<string, string>()
  for (const line of lines.slice(1, -1)) {
    const separator = line.indexOf('='), key = separator > 0 ? line.slice(0, separator) : ''
    // Complete records have a closed schema. Reject unknown fields (including
    // `created`) and every duplicate rather than allowing a later line to
    // shadow the value that an owner wrote first.
    if (separator <= 0 || !['pid', 'start', 'token'].includes(key) || values.has(key)) return null
    values.set(key, line.slice(separator + 1))
  }
  const pidText = values.get('pid'), start = values.get('start'), token = values.get('token')
  if (!pidText || !start || !token || !/^\d+$/.test(pidText) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(start) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(token)) return null
  const pid = Number(pidText)
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff ? { pid, start, token } : null
}

function parseLinuxStart(text: string): string | null {
  const end = text.lastIndexOf(') ')
  if (end < 0) return null
  const fields = text.slice(end + 2).trim().split(/\s+/)
  const start = fields[19] // /proc stat field 22; fields[0] is field 3 (state).
  return start && /^\d+$/.test(start) ? `linux:${start}` : null
}

export function parseLinuxProcessStart(text: string): string | null { return parseLinuxStart(text) }

async function processStartIdentity(pid: number): Promise<string | null | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const parsed = parseLinuxStart(await (await import('node:fs/promises')).readFile(`/proc/${pid}/stat`, 'utf8'))
      return parsed ?? undefined
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
      return undefined
    }
  }
  if (process.platform === 'darwin') {
    try {
      const result = await execFile('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 250, maxBuffer: 4096 })
      const value = result.stdout.trim().replace(/\s+/g, '_')
      return value ? `darwin:${value}` : null
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ESRCH' || code === 'ENOENT' ? null : undefined
    }
  }
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { Write-Output AMBER_PROCESS_NOT_FOUND } else { try { Write-Output $p.StartTime.ToFileTimeUtc() } catch { exit 2 } }`
    try {
      const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 250, maxBuffer: 4096, windowsHide: true })
      const value = result.stdout.trim()
      if (value === 'AMBER_PROCESS_NOT_FOUND') return null
      return /^\d+$/.test(value) ? `windows:${value}` : undefined
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      // A failed query is not proof that the PID is gone: access denial,
      // PowerShell failure, and a process exiting during StartTime lookup all
      // must leave the lock unreclaimed.
      return undefined
    }
  }
  return undefined
}

export async function currentProcessStartIdentity(): Promise<string | null> {
  const identity = await processStartIdentity(process.pid)
  return typeof identity === 'string' ? identity : null
}

async function ownerState(record: LayoutLockRecord): Promise<'live' | 'dead' | 'unknown'> {
  const identity = await processStartIdentity(record.pid)
  if (identity === null) return 'dead'
  if (identity === undefined || record.start === 'unknown' || record.start.startsWith('unknown:')) return 'unknown'
  return identity === record.start ? 'live' : 'dead'
}

async function snapshot(path: string): Promise<LockSnapshot | null> {
  const text = await readSafeTextFile(path, { maxBytes: LOCK_RECORD_MAX_BYTES })
  if (text === null) return null
  const stat = await lstat(path)
  return { record: parseLayoutLockRecord(text), text, stat }
}

/**
 * Recover only the owner identity from an old lock that was published by
 * writing the final pathname in place. A complete new lock is always parsed
 * by `parseLayoutLockRecord`; this fallback is intentionally incomplete and
 * can reclaim only when the old PID/start identity is demonstrably dead.
 *
 * A partial legacy record with no complete PID and start field is not safely
 * reclaimable: removing it could race a still-writing old owner. Such a file
 * fails closed until an operator removes it after verifying the old process.
 */
function parseLegacyOwner(text: string): LayoutLockRecord | null {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = body.split('\n')
  if (lines[0] !== LOCK_PROTOCOL) return null
  let pid: number | undefined
  let start: string | undefined
  // Duplicate fields are rejected even when byte-identical. Legacy recovery
  // must never choose a later value from an ambiguous record.
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    const separator = line.indexOf('='), key = separator > 0 ? line.slice(0, separator) : ''
    if (separator <= 0 || !['pid', 'start', 'token', 'created'].includes(key) || seen.has(key)) return null
    seen.add(key)
    const value = line.slice(separator + 1)
    if (key === 'pid') {
      if (!/^\d+$/.test(value)) return null
      const candidate = Number(value)
      if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > 0xffff_ffff) return null
      pid = candidate
    } else if (key === 'start') {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) return null
      start = value
    } else if ((key === 'token' || key === 'created') && !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) {
      return null
    }
  }
  return pid !== undefined && start !== undefined ? { pid, start, token: '' } : null
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function removeIfUnchanged(path: string, expected: LockSnapshot): Promise<boolean> {
  let current: LockSnapshot | null
  try { current = await snapshot(path) } catch { return false }
  if (!current || current.record?.token !== expected.record?.token || current.text !== expected.text || !sameFile(current.stat, expected.stat)) return false
  try { await unlink(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function lockTimeout(): Error { return new Error('LAYOUT_LOCK_TIMEOUT') }

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function lockPublicationError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EPERM') return new Error('LAYOUT_LOCK_UNSUPPORTED')
  return error instanceof Error ? error : new Error(String(error))
}

export interface LayoutLock {
  release(): Promise<void>
}

export async function acquireLayoutLock(path: string, waitMs = LOCK_WAIT_MS): Promise<LayoutLock> {
  const started = Date.now()
  const start = await currentProcessStartIdentity() ?? `unknown:${process.pid}`
  const token = randomUUID().replace(/-/g, '')
  const owner = { pid: process.pid, start, token }
  const text = formatLayoutLockRecord(owner)
  const parent = dirname(path)
  for (;;) {
    // Never create the final pathname until the complete, fsynced owner record
    // is ready. `link` is the cross-language no-replace publication primitive:
    // both Node and Rust either expose the whole record or leave no final lock.
    const temporary = `${path}.${process.pid}.${token}.${randomUUID()}.tmp`
    let contended = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
      try {
        await link(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') contended = true
        else throw lockPublicationError(error)
      }
      if (!contended) {
        // The final pathname now names the complete prepared inode. Cleanup is
        // not part of publication; a crash before this unlink leaves only an
        // unreferenced preparation alongside a valid lock.
        await unlink(temporary).catch(() => {})
        const acquiredStat = await lstat(path)
        const acquired: LockSnapshot = { record: owner, text, stat: acquiredStat }
        await syncDirectory(parent).catch(() => {})
        return { release: async () => { await removeIfUnchanged(path, acquired) } }
      }
    } finally {
      await unlink(temporary).catch(() => {})
    }

    const current = await snapshot(path).catch(() => null)
    if (current) {
      // A valid record is the normal path. A malformed final file can only be
      // from the pre-publication protocol; reclaim it only when its complete
      // legacy PID/start identity is demonstrably dead. An unidentifiable
      // partial write stays in place and fails closed rather than stealing a
      // live old owner.
      const legacyOwner = current.record ?? parseLegacyOwner(current.text)
      if (legacyOwner && await ownerState(legacyOwner) === 'dead') {
        await removeIfUnchanged(path, current)
        continue
      }
    }
    const remaining = waitMs - (Date.now() - started)
    if (remaining <= 0) throw lockTimeout()
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)))
  }
}
