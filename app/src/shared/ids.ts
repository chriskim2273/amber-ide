// A Claude Code session id is a UUID. `reloadClaude` (SplitView) interpolates
// the id into a command line run in a pane's SHELL, so it MUST match this
// exactly before use — a value carrying shell metacharacters (`; rm -rf ~`,
// `$(…)`, backticks) would otherwise be executed. Validate at the trust
// boundary regardless of where the id came from.
export const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when `id` is a well-formed Claude Code session id (UUID). */
export function isClaudeSessionId(id: string): boolean {
  return CLAUDE_SESSION_ID.test(id)
}
