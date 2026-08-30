import { isAgentKind, type AppState, type PaneModel, type ResourcePressureCause, type WorkspaceModel } from './store'

export type CommandCenterGroupId = 'needs-you' | 'working' | 'parked' | 'quiet'

export interface CommandCenterItem {
  pane: PaneModel
  ws: number
  tab: number
  group: CommandCenterGroupId
  stateLabel: string
  unseenActivity: boolean
  activitySeq: number
  rssKb?: number | undefined
  growing?: boolean | undefined
  /** Internal deterministic urgency rank. Lower appears first. */
  urgency: number
}

export interface CommandCenterGroup {
  id: CommandCenterGroupId
  label: string
  items: CommandCenterItem[]
}

export interface CommandCenterAlert {
  id: 'memory' | 'resources'
  level: 'critical'
  text: string
}

export interface CommandCenterModel {
  groups: CommandCenterGroup[]
  alerts: CommandCenterAlert[]
  count: number
}

export interface CommandCenterInput {
  workspaces: WorkspaceModel[]
  state: Pick<AppState, 'lastActivity' | 'lastSeen' | 'mem' | 'pressure' | 'resourcePressure'>
  frozen: ReadonlySet<string>
  /** Optional display-only filter. Grouping and daemon state remain untouched. */
  workspace?: number | undefined
}

const GROUPS: ReadonlyArray<{ id: CommandCenterGroupId; label: string }> = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'parked', label: 'Parked' },
  { id: 'quiet', label: 'Quiet' },
]

const PARKED_STATES = new Set(['suspended', 'memory-suspended', 'resource-suspended'])

function kindLabel(kind: string): string {
  return kind.length === 0 ? 'Session' : kind[0]!.toUpperCase() + kind.slice(1)
}

function classify(
  pane: PaneModel,
  frozen: boolean,
  unseenActivity: boolean,
): Pick<CommandCenterItem, 'group' | 'stateLabel' | 'urgency'> {
  // Dead always wins over app-owned freeze state and stale run_state. The Exit
  // event can arrive before the next Sessions snapshot, so either signal is
  // authoritative enough to classify the row as exited.
  if (!pane.alive || pane.deadCode !== null) {
    return { group: 'needs-you', stateLabel: 'Session exited', urgency: 0 }
  }

  switch (pane.runState) {
    case 'claude-retrying':
      return { group: 'needs-you', stateLabel: `${kindLabel(pane.kind)} retrying`, urgency: 1 }
    case 'shell-fallback':
      return { group: 'needs-you', stateLabel: `${kindLabel(pane.kind)} exited to shell`, urgency: 2 }
    case 'suspend-failed':
      return { group: 'needs-you', stateLabel: 'Could not suspend session', urgency: 3 }
  }

  if (frozen) return { group: 'parked', stateLabel: 'Frozen by you', urgency: 0 }
  if (PARKED_STATES.has(pane.runState ?? '')) {
    const stateLabel = pane.runState === 'memory-suspended'
      ? 'Parked to protect system memory'
      : pane.runState === 'resource-suspended'
        ? 'Parked to protect system resources'
        : 'Suspended to free memory'
    return { group: 'parked', stateLabel, urgency: 1 }
  }

  // A live supervised agent reports that it is running. For shells, the only
  // honest working signal Amber has is output not yet seen by the user; no wall
  // clock or TUI scraping is invented here.
  if (isAgentKind(pane.kind)) {
    return { group: 'working', stateLabel: `${kindLabel(pane.kind)} working`, urgency: 0 }
  }
  if (unseenActivity) return { group: 'working', stateLabel: 'Recent output', urgency: 0 }
  return { group: 'quiet', stateLabel: `Quiet ${pane.kind || 'session'}`, urgency: 0 }
}

function compareItems(a: CommandCenterItem, b: CommandCenterItem): number {
  // Activity is intentionally not a sort key. Output updates can arrive several
  // times a second, and moving a row under the user's finger made the mobile
  // command center difficult to operate. Slots are daemon-owned and stable for
  // the lifetime of a session, so they provide a predictable touch target while
  // urgency still keeps genuinely actionable states first.
  return a.urgency - b.urgency
    || (a.pane.slot || Number.MAX_SAFE_INTEGER) - (b.pane.slot || Number.MAX_SAFE_INTEGER)
    || a.ws - b.ws
    || a.tab - b.tab
    || a.pane.ord - b.pane.ord
    || a.pane.name.localeCompare(b.pane.name)
}

function resourceCauseText(causes: ResourcePressureCause[]): string {
  const labels = causes.map((cause) => ({ cpu: 'CPU', io: 'I/O', memory: 'memory' })[cause] ?? cause)
  const text = labels.length === 0 ? 'System resource'
    : labels.length === 1 ? labels[0]!
      : labels.length === 2 ? `${labels[0]} and ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
  return text[0]!.toUpperCase() + text.slice(1)
}

/**
 * Pure cross-client command-center projection. It only groups daemon-backed panes
 * whose state Amber can prove; it never infers TUI completion or waiting from
 * terminal output. Global pressure remains a global alert instead of assigning
 * blame to an arbitrary session.
 */
export function commandCenterModel({ workspaces, state, frozen, workspace }: CommandCenterInput): CommandCenterModel {
  const buckets = new Map<CommandCenterGroupId, CommandCenterItem[]>(GROUPS.map((group) => [group.id, []]))

  for (const workspaceModel of workspaces) {
    if (workspace !== undefined && workspaceModel.ws !== workspace) continue
    for (const tab of workspaceModel.tabs) {
      for (const pane of tab.panes) {
        // Browser/editor panes have no daemon terminal transport in the mobile
        // web surface. Hiding by kind here is the explicit product cut; these
        // entries remain untouched in the authoritative sidecar.
        if (pane.kind === 'browser' || pane.kind === 'editor') continue
        const activitySeq = state.lastActivity[pane.name] ?? 0
        const unseenActivity = activitySeq > (state.lastSeen[pane.name] ?? 0)
        const classification = classify(pane, frozen.has(pane.name), unseenActivity)
        const memory = state.mem[pane.name]
        buckets.get(classification.group)!.push({
          pane,
          ws: workspaceModel.ws,
          tab: tab.tab,
          unseenActivity,
          activitySeq,
          rssKb: memory?.rssKb,
          growing: memory?.growing,
          ...classification,
        })
      }
    }
  }

  const groups = GROUPS.map((group) => ({
    ...group,
    items: buckets.get(group.id)!.sort(compareItems),
  }))
  const alerts: CommandCenterAlert[] = []
  if (state.pressure?.level === 'critical') {
    alerts.push({
      id: 'memory',
      level: 'critical',
      text: state.pressure.blocked
        ? 'Memory pressure is critical. Close or freeze active work.'
        : 'Memory pressure is critical. Amber may park idle agents.',
    })
  }
  if (state.resourcePressure?.level === 'critical') {
    alerts.push({
      id: 'resources',
      level: 'critical',
      text: `${resourceCauseText(state.resourcePressure.causes)} pressure is critical. ${state.resourcePressure.blocked ? 'Close or freeze active work.' : 'Amber may park idle agents.'}`,
    })
  }
  return { groups, alerts, count: groups.reduce((sum, group) => sum + group.items.length, 0) }
}
