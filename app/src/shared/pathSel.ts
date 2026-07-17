// Turn a raw terminal text selection into ordered path candidates to stat.
// Pure (no fs) so it's unit-testable; the caller stats each in order and takes
// the first that exists. Order matters: the most literal form first, then
// heuristic strips (surrounding quotes are already removed; a trailing
// grep/compiler `:line[:col]` suffix is peeled as a fallback).
export function pathCandidates(raw: string): string[] {
  const t = raw.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!t) return []
  const out = [t]
  const m = t.match(/^(.+?):\d+(:\d+)?$/) // file.ts:42  or  file.ts:42:7
  if (m?.[1]) out.push(m[1])
  return out
}
