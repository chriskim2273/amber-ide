import { randomUUID } from 'node:crypto'
import { lstat, open, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { readSafeTextFile } from './safeFileReader'

const execFile = promisify(execFileCallback)
const LOCK_PROTOCOL = 'amber-layout-lock-v1'
const LOCK_RECORD_MAX_BYTES = 4096
const LOCK_WAIT_MS = 2_000

export interface LayoutLockRecord { pid: number; start: string; token: string }
interface LockSnapshot { record: LayoutLockRecord; text: string; stat: Stats }

export function formatLayoutLockRecord(record: LayoutLockRecord): string {
  return `${LOCK_PROTOCOL}\npid=${record.pid}\nstart=${record.start}\ntoken=${record.token}\n`
}

export function parseLayoutLockRecord(text: string): LayoutLockRecord | null {
  const lines = text.split('\n')
  if (lines.at(-1) !== '' || lines[0] !== LOCK_PROTOCOL) return null
  const values = new Map<string, string>()
  for (const line of lines.slice(1, -1)) {
    const separator = line.indexOf('=')
    if (separator <= 0 || values.has(line.slice(0, separator))) return null
    values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const pidText = values.get('pid'), start = values.get('start'), token = values.get('token')
  if (!pidText || !start || !token || !/^\d+$/.test(pidText) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(start) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(token)) return null
  const pid = Number(pidText)
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, start, token } : null
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
  const record = parseLayoutLockRecord(text)
  if (!record) return { record: { pid: 1, start: 'unknown', token: '' }, text, stat }
  return { record, text, stat }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function removeIfUnchanged(path: string, expected: LockSnapshot): Promise<boolean> {
  let current: LockSnapshot | null
  try { current = await snapshot(path) } catch { return false }
  if (!current || current.record.token !== expected.record.token || current.text !== expected.text || !sameFile(current.stat, expected.stat)) return false
  try { await unlink(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function lockTimeout(): Error { return new Error('LAYOUT_LOCK_TIMEOUT') }

export interface LayoutLock {
  release(): Promise<void>
}

export async function acquireLayoutLock(path: string, waitMs = LOCK_WAIT_MS): Promise<LayoutLock> {
  const started = Date.now()
  const start = await currentProcessStartIdentity() ?? `unknown:${process.pid}`
  const token = randomUUID().replace(/-/g, '')
  const text = formatLayoutLockRecord({ pid: process.pid, start, token })
  for (;;) {
    let handle: FileHandle | null = null
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      const acquiredStat = await handle.stat()
      const acquired: LockSnapshot = { record: { pid: process.pid, start, token }, text, stat: acquiredStat }
      const ownerHandle = handle
      return {
        release: async () => {
          await ownerHandle.close().catch(() => {})
          await removeIfUnchanged(path, acquired)
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = await snapshot(path).catch(() => null)
      if (current) {
        const state = current.record.token ? await ownerState(current.record) : 'unknown'
        if (state === 'dead') { await removeIfUnchanged(path, current); continue }
      }
      if (Date.now() - started >= waitMs) throw lockTimeout()
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, waitMs - (Date.now() - started))))
    }
  }
}
