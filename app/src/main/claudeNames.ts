// Resolve a claude session id to a human label by reading its transcript.
// Renderer-side, `~/.claude` is unreachable (sandboxed), so this lives in main
// like every other disk read (editorFiles.ts).

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { summarize } from '../shared/claudeSummary'

/** Only bytes we might need: the label comes from the transcript's HEAD (the
 * summary line, or the first user turn). Reading a multi-MB conversation in
 * full to show one line of UI would stall the cleanup dialog. */
const HEAD_BYTES = 256 * 1024

/** A claude session id is a uuid — anything else is not ours to go looking for
 * on disk, and would make this a path-traversal read primitive. */
const UUID = /^[0-9a-fA-F-]{8,64}$/

function projectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * The transcript path for `id`, or null.
 *
 * Claude slugs a project dir from its cwd by rewriting every non-alphanumeric
 * run (`/home/p/x/.claude/wt` → `-home-p-x--claude-wt`), which is lossy and
 * therefore not safely invertible. So: try the slug of the session's own cwd
 * first (one stat, the common case), then fall back to scanning the project
 * dirs. The scan is what makes a moved/renamed project still resolve.
 */
function transcriptPath(id: string, cwd: string): string | null {
  const root = projectsDir()
  if (!existsSync(root)) return null
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const direct = join(root, slug, `${id}.jsonl`)
  if (existsSync(direct)) return direct
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(root, d, `${id}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

/** Read at most the first HEAD_BYTES of a file, dropping a trailing partial line. */
function head(path: string): string[] {
  const size = statSync(path).size
  const buf = readFileSync(path)
  const text = buf.subarray(0, Math.min(size, HEAD_BYTES)).toString('utf8')
  const lines = text.split('\n')
  if (size > HEAD_BYTES) lines.pop() // truncated mid-line
  return lines
}

/**
 * Labels for claude session ids, keyed by id. Ids that resolve to nothing are
 * simply absent — the caller falls back to the cwd, which is always known.
 * Never throws: a missing/unreadable transcript must not break the dialog.
 */
export function claudeNames(entries: { id: string; cwd: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { id, cwd } of entries) {
    if (!UUID.test(id)) continue
    try {
      const path = transcriptPath(id, typeof cwd === 'string' ? cwd : '')
      if (!path) continue
      const label = summarize(head(path))
      if (label) out[id] = label
    } catch {
      // unreadable transcript — leave it unnamed
    }
  }
  return out
}
