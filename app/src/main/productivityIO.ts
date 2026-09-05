import { mkdir, writeFile, rename, readdir, stat, lstat, rm, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import type { LoadProductivityResult, SaveProductivityResult } from '../shared/productivity'
import { parseProjectProfile, type ProjectProfile } from '../shared/projectProfile'
import { CHECKPOINT_FILE_MAX, CHECKPOINT_ID, parseCheckpoint, parseCheckpointMeta, type CheckpointSummary } from '../shared/checkpoint'
import { readSafeTextFile, SafeFileReadError } from './safeFileReader'

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}

export async function loadProductivityFile(path: string): Promise<LoadProductivityResult> {
  try {
    const owner = process.getuid?.()
    const text = await readSafeTextFile(path, { maxBytes: 4 * 1024 * 1024, ...(owner === undefined ? {} : { owner }) })
    return text === null ? { text: null, version: null } : { text, version: text }
  } catch { return { text: null, version: null } }
}

export async function saveProductivityFile(
  path: string, text: string, expected: string | null,
): Promise<SaveProductivityResult> {
  try {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return { error: 'productivity file exceeds 4 MiB' }
    const info = await lstat(path).catch(() => null)
    if (info && (!info.isFile() || info.isSymbolicLink())) return { error: 'productivity path is not a regular file' }
    const owner = process.getuid?.()
    let current: string | null
    try { current = await readSafeTextFile(path, { maxBytes: 4 * 1024 * 1024, ...(owner === undefined ? {} : { owner }) }) }
    catch (error) { return { error: error instanceof SafeFileReadError ? error.code : error instanceof Error ? error.message : String(error) } }
    if (current !== expected) return { conflict: true, text: current, version: current }
    try {
      const raw = JSON.parse(text) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>)['version'] !== 1) {
        return { error: 'invalid productivity file' }
      }
    } catch { return { error: 'invalid productivity file' } }
    await atomicWrite(path, text)
    return { ok: true, version: text }
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

function contained(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function readProjectProfile(root: string): Promise<
  { profile: ProjectProfile; root: string; resolvedCwds: string[] } | { error: string }
> {
  try {
    const canonicalRoot = await realpath(root)
    const source = await readSafeTextFile(join(canonicalRoot, '.amber.toml'), { maxBytes: 64 * 1024 })
    if (source === null) throw new Error('.amber.toml is missing')
    if (Buffer.byteLength(source) > 64 * 1024) return { error: '.amber.toml exceeds 64 KiB' }
    const profile = parseProjectProfile(source)
    const resolvedCwds: string[] = []
    for (const pane of profile.panes) {
      const candidate = resolve(canonicalRoot, pane.cwd)
      if (!contained(canonicalRoot, candidate)) throw new Error('pane cwd escapes the project root')
      const canonical = await realpath(candidate)
      if (!contained(canonicalRoot, canonical) || !(await stat(canonical)).isDirectory()) {
        throw new Error(`pane cwd is not a project directory: ${pane.cwd}`)
      }
      resolvedCwds.push(canonical)
    }
    return { profile, root: canonicalRoot, resolvedCwds }
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

function checkpointPath(root: string, id: string): string {
  if (!CHECKPOINT_ID.test(id)) throw new Error('invalid checkpoint id')
  const dir = join(root, 'checkpoints')
  const path = join(dir, `${id}.amberws`)
  if (!contained(dir, path)) throw new Error('checkpoint path escapes its directory')
  return path
}

export async function writeCheckpoint(root: string, id: string, text: string): Promise<void> {
  const parsed = parseCheckpoint(text)
  if (parsed.checkpoint.id !== id) throw new Error('checkpoint id does not match document')
  await atomicWrite(checkpointPath(root, id), text)
  await pruneAutomaticCheckpoints(root)
}

export async function readCheckpoint(root: string, id: string): Promise<string> {
  const path = checkpointPath(root, id)
  let text: string | null
  try { text = await readSafeTextFile(path, { maxBytes: CHECKPOINT_FILE_MAX }) }
  catch (error) {
    if (error instanceof SafeFileReadError) {
      if (error.code === 'SYMLINK' || error.code === 'NOT_REGULAR') throw new Error('checkpoint is not a regular file')
      if (error.code === 'FILE_TOO_LARGE') throw new Error('checkpoint exceeds 128 MiB')
      if (error.code === 'INVALID_UTF8') throw new Error('checkpoint is not valid UTF-8')
    }
    throw error
  }
  if (text === null) throw new Error('checkpoint is not a regular file')
  parseCheckpoint(text)
  return text
}

export async function deleteCheckpoint(root: string, id: string): Promise<void> {
  await rm(checkpointPath(root, id), { force: true })
}

const CHECKPOINT_META_PREFIX_MAX = 4096

function firstJsonObject(text: string, start: number): string {
  let depth = 0; let inString = false; let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1)
  }
  throw new Error('checkpoint metadata exceeds its bounded prefix')
}

async function checkpointSummary(path: string, bytes: number): Promise<CheckpointSummary> {
  const prefix = await readSafeTextFile(path, { maxBytes: CHECKPOINT_FILE_MAX, readBytes: CHECKPOINT_META_PREFIX_MAX })
  if (prefix === null) throw new Error('checkpoint is not a regular file')
  const marker = '{"checkpoint":'
  if (!prefix.startsWith(marker)) throw new Error('checkpoint metadata is not first')
  const metaText = firstJsonObject(prefix, marker.length)
  return { ...parseCheckpointMeta(JSON.parse(metaText) as unknown), bytes }
}

async function checkpointCandidates(root: string): Promise<Array<{ path: string; bytes: number; mtime: number }>> {
  const dir = join(root, 'checkpoints')
  const names = await readdir(dir).catch(() => [])
  const candidates: Array<{ path: string; bytes: number; mtime: number }> = []
  for (const name of names.filter((entry) => entry.endsWith('.amberws'))) {
    try {
      const path = join(dir, name)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > CHECKPOINT_FILE_MAX) continue
      candidates.push({ path, bytes: info.size, mtime: info.mtimeMs })
    } catch { /* a concurrently removed entry is simply absent */ }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)
}

export async function listCheckpoints(root: string): Promise<CheckpointSummary[]> {
  const summaries: CheckpointSummary[] = []
  for (const candidate of (await checkpointCandidates(root)).slice(0, 100)) {
    try { summaries.push(await checkpointSummary(candidate.path, candidate.bytes)) }
    catch { /* malformed checkpoints are isolated, never break the list */ }
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt)
}

async function pruneAutomaticCheckpoints(root: string): Promise<void> {
  const summaries: CheckpointSummary[] = []
  for (const candidate of await checkpointCandidates(root)) {
    try { summaries.push(await checkpointSummary(candidate.path, candidate.bytes)) } catch { /* isolated */ }
  }
  const automatic = summaries.filter((entry) => entry.automatic).sort((a, b) => b.createdAt - a.createdAt)
  for (const stale of automatic.slice(20)) await rm(checkpointPath(root, stale.id), { force: true })
}

export { contained }
