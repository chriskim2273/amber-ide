// Prompt-enhancement contract shared by main (IPC validation) and the
// renderer (input limits). Mirrors the Rust side in
// `crates/amber/src/router_ops.rs`: the same rules are enforced again by
// `amber ctl router complete`, which is the real boundary — this copy only
// fails fast so a blank paste never spawns a subprocess.

/** Largest prompt accepted, in chars. Matches `ENHANCE_MAX_CHARS`. */
export const ENHANCE_MAX_CHARS = 12_000

export interface EnhanceResult {
  ok: boolean
  text?: string
  error?: string
}

type ValidInput = { ok: true; prompt: string } | { ok: false; error: string }

/**
 * Fail fast on blank/oversize input. Never throws — the value crosses the
 * renderer boundary, so its shape cannot be trusted.
 */
export function validateEnhanceInput(value: unknown): ValidInput {
  if (typeof value !== 'string') return { ok: false, error: 'expected a text prompt' }
  const prompt = value.trim()
  if (prompt.length === 0) return { ok: false, error: 'enter a prompt to enhance' }
  // JS counts UTF-16 code units, Rust counts chars: `length` is always >= the
  // Rust count, so this check is strictly conservative — anything passing
  // here also passes the CLI's own limit.
  if (prompt.length > ENHANCE_MAX_CHARS) {
    return { ok: false, error: `prompt is too long (max ${ENHANCE_MAX_CHARS} chars)` }
  }
  return { ok: true, prompt }
}

/** Parse, never throw: stdout from `amber ctl router complete --json`. */
export function parseEnhanceResult(stdout: string): EnhanceResult {
  let raw: unknown
  try {
    raw = JSON.parse(stdout) as unknown
  } catch {
    return { ok: false, error: 'could not parse the router reply' }
  }
  const text = (raw as { text?: unknown } | null)?.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'the router returned no text' }
  }
  return { ok: true, text: text.trim() }
}
