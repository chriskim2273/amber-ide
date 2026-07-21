// Naming a claude session for the session-cleanup view. A daemon session's
// identity is `amber-<ws>-<tab>-<ord>-<id>` plus a cwd — neither of which says
// WHAT the conversation is about, which is the whole question when deciding
// which of a dozen leftover sessions to kill.
//
// The claude transcript at `~/.claude/projects/<slug>/<claude_id>.jsonl` has
// the answer, but not reliably in one place: a `{"type":"summary"}` line exists
// only once claude has written one (measured: none of this repo's transcripts
// had one), so the fallback is the first real user prompt. "Real" is doing work
// there — the opening turn is routinely a slash-command caveat, a hook dump, or
// a system reminder, none of which the user ever typed.

/** Wrapper blocks that are harness plumbing, never user intent. */
const NOISE = [
  /<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g,
  /<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  // Unterminated variants: a truncated transcript line can cut mid-block, and
  // leaving the opening tag in would make it the "summary".
  /<local-command-[^>]*>[\s\S]*$/g,
  /<system-reminder>[\s\S]*$/g,
]

/** Strip harness wrappers and collapse whitespace. '' if nothing survives. */
export function cleanPrompt(raw: string): string {
  let s = raw
  for (const re of NOISE) s = s.replace(re, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** A transcript line's user text, or '' if the line is not a user turn. */
function userText(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return ''
  const o = entry as { type?: unknown; message?: { content?: unknown } }
  if (o.type !== 'user') return ''
  const c = o.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map((p) => (typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join(' ')
}

/**
 * A short human label for a claude transcript, given its lines (JSONL, in file
 * order). Prefers claude's own `summary`; else the first user turn that is not
 * pure harness noise. '' when the transcript yields nothing usable — the caller
 * shows the cwd alone rather than inventing a name.
 */
export function summarize(lines: string[], max = 80): string {
  let firstPrompt = ''
  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // a partially-written last line is normal for a live session
    }
    const o = entry as { type?: unknown; summary?: unknown }
    if (o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) {
      return truncate(o.summary.trim(), max) // claude's own title wins outright
    }
    if (!firstPrompt) firstPrompt = cleanPrompt(userText(entry))
  }
  return firstPrompt ? truncate(firstPrompt, max) : ''
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}
