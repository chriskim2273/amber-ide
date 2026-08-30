import { mkdir, readFile, writeFile, rename, readdir, stat, rm, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import type { LoadProductivityResult, SaveProductivityResult } from '../shared/productivity'
import { parseProjectProfile, type ProjectProfile } from '../shared/projectProfile'
import { CHECKPOINT_FILE_MAX, CHECKPOINT_ID, parseCheckpoint, type CheckpointSummary } from '../shared/checkpoint'

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}

export async function loadProductivityFile(path: string): Promise<LoadProductivityResult> {
  try { const text = await readFile(path, 'utf8'); return { text, version: text } }
  catch { return { text: null, version: null } }
}

export async function saveProductivityFile(
  path: string, text: string, expected: string | null,
): Promise<SaveProductivityResult> {
  try {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return { error: 'productivity file exceeds 4 MiB' }
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== expected) return { conflict: true, text: current, version: current }
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
    const source = await readFile(join(canonicalRoot, '.amber.toml'), 'utf8')
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
  const text = await readFile(checkpointPath(root, id), 'utf8')
  parseCheckpoint(text)
  return text
}

export async function deleteCheckpoint(root: string, id: string): Promise<void> {
  await rm(checkpointPath(root, id), { force: true })
}

export async function listCheckpoints(root: string): Promise<CheckpointSummary[]> {
  const dir = join(root, 'checkpoints')
  const names = await readdir(dir).catch(() => [])
  const summaries: CheckpointSummary[] = []
  for (const name of names.filter((entry) => entry.endsWith('.amberws')).slice(0, 100)) {
    try {
      const path = join(dir, name)
      const info = await stat(path)
      if (!info.isFile() || info.size > CHECKPOINT_FILE_MAX) continue
      const doc = parseCheckpoint(await readFile(path, 'utf8'))
      summaries.push({ ...doc.checkpoint, bytes: info.size })
    } catch { /* malformed checkpoints are isolated, never break the list */ }
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt)
}

async function pruneAutomaticCheckpoints(root: string): Promise<void> {
  const automatic = (await listCheckpoints(root)).filter((entry) => entry.automatic)
  for (const stale of automatic.slice(20)) await rm(checkpointPath(root, stale.id), { force: true })
}

export { contained }
