// Module-level scrollback-replay handoff for workspace load. The load
// orchestration stages saved scrollback keyed by the freshly minted session
// name; each Pane consumes (and deletes) its entry ONCE in its [session] mount
// effect, writing the bytes into xterm before wiring the live port.
//
// A module singleton (not a Pane prop) so it never enters Pane's memo signature
// — adding a prop would defeat the "xterm outside React reconciliation" invariant
// and reconcile every terminal on each drag mousemove. Entries persist until
// consumed: a new-mode workspace's panes only mount when the user first VISITS
// that workspace (SplitView renders the active tab only), which can be long after
// the load committed. Fresh daemon sessions have empty backlog, so the staged
// history writes first and live output appends after — display-correct ordering.

const staged = new Map<string, Uint8Array>()

export function stageReplay(map: Record<string, Uint8Array>): void {
  for (const [name, data] of Object.entries(map)) staged.set(name, data)
}

export function takeReplay(session: string): Uint8Array | undefined {
  const data = staged.get(session)
  if (data !== undefined) staged.delete(session)
  return data
}
