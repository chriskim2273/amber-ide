import type { SessionInfo } from '../shared/proto'
import { parseName } from '../shared/names'

export interface SessionRow {
  name: string
  cwd: string
  kind: string
  alive: boolean
  slot: number
  /** Workspace/tab this session shows up in, or null when no pane can show it. */
  ws: number | null
  tab: number | null
  /** False = live in the daemon but unreachable from the UI. */
  inPane: boolean
  /** What the claude conversation is about; '' when unknown or not claude. */
  claudeName: string
}

/**
 * The cleanup view's rows: every session the daemon still lists, with enough
 * context to decide which to kill.
 *
 * `inPane` is derivable here with no daemon help because grouping is encoded in
 * the session name (core rule #2) — a name the grammar rejects belongs to no
 * workspace, so nothing in the UI will ever show it, and `amber ls` is the only
 * place it appears.
 *
 * Ordered by slot, the number the header and `amber attach <n>` both use, so
 * the dialog and the panes read the same. Slot 0 means unassigned (an older
 * daemon, or a session the app never numbered) and sorts last rather than
 * first, where it would look like #0.
 */
export function sessionRows(sessions: SessionInfo[], claudeNames: Record<string, string>): SessionRow[] {
  return sessions
    .map((s): SessionRow => {
      const p = parseName(s.name)
      return {
        name: s.name,
        cwd: s.cwd,
        kind: s.kind,
        alive: s.alive,
        slot: s.slot ?? 0,
        ws: p ? p.ws : null,
        tab: p ? p.tab : null,
        inPane: p !== null,
        claudeName: (s.claude_id && claudeNames[s.claude_id]) || '',
      }
    })
    .sort((a, b) => (a.slot || Infinity) - (b.slot || Infinity))
}
