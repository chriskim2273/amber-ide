import type { PaneKind } from './SplitView'

export interface PaneKindOption {
  kind: PaneKind
  label: string
  detail: string
}

export const PANE_KIND_OPTIONS: readonly PaneKindOption[] = [
  { kind: 'shell', label: 'Shell', detail: 'A persistent terminal session' },
  { kind: 'claude', label: 'Claude', detail: 'Supervised Claude Code conversation' },
  { kind: 'grok', label: 'Grok', detail: 'Supervised Grok conversation' },
  { kind: 'codex', label: 'Codex', detail: 'Supervised OpenAI Codex conversation' },
  { kind: 'opencode', label: 'OpenCode', detail: 'Supervised OpenCode conversation' },
  { kind: 'hermes', label: 'Hermes', detail: 'Supervised Hermes conversation' },
  { kind: 'pi', label: 'Pi', detail: 'Supervised Pi conversation' },
  { kind: 'editor', label: 'Editor', detail: 'App-local file editor' },
] as const

export type DaemonPaneKind = Exclude<PaneKind, 'editor'>
export type DaemonPaneKindOption = PaneKindOption & { kind: DaemonPaneKind }

/** One metadata source for every client; capability filters choose the surface. */
export const DAEMON_PANE_KIND_OPTIONS: readonly DaemonPaneKindOption[] = PANE_KIND_OPTIONS.filter(
  (option): option is DaemonPaneKindOption => option.kind !== 'editor',
)

export function machineWindowTitle(localMachine: string, remoteHost: string): string {
  return `Amber · ${remoteHost.trim() || localMachine.trim() || 'local'}`
}

export interface PaneHeaderPresentation {
  state: { kind: 'attention' | 'frozen' | 'parked' | 'zoomed'; label: string; title: string } | null
  showMemory: boolean
}

/** Collapse competing pane metadata to one operational state, then telemetry. */
export function paneHeaderPresentation(input: {
  frozen: boolean
  runState: string | null | undefined
  zoomed: boolean
  rssKb: number | undefined
  growing: boolean | undefined
  width: number
}): PaneHeaderPresentation {
  let state: PaneHeaderPresentation['state'] = null
  if (input.frozen) {
    state = { kind: 'frozen', label: 'Frozen by you', title: 'Manually frozen in Amber' }
  } else if (input.runState === 'claude-retrying') {
    state = { kind: 'attention', label: 'Retrying', title: 'The supervised agent is retrying' }
  } else if (input.runState === 'shell-fallback') {
    state = { kind: 'attention', label: 'Exited to shell', title: 'The supervised agent exited to a shell' }
  } else if (input.runState === 'suspend-failed') {
    state = { kind: 'attention', label: 'Suspend failed', title: 'Amber could not suspend this session' }
  } else if (input.runState === 'memory-suspended') {
    state = { kind: 'parked', label: 'Parked for memory', title: 'Parked by the memory guardian' }
  } else if (input.runState === 'resource-suspended') {
    state = { kind: 'parked', label: 'Parked for resources', title: 'Parked by the resource guardian' }
  } else if (input.runState === 'suspended') {
    state = { kind: 'parked', label: 'Suspended', title: 'Suspended to free agent memory' }
  } else if (input.zoomed) {
    state = { kind: 'zoomed', label: 'Zoomed', title: 'Restore the workspace layout with the zoom shortcut' }
  }

  return {
    state,
    showMemory: state === null
      && (input.rssKb ?? 0) > 0
      && (input.growing === true || input.width >= 480),
  }
}

export type SnapshotState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'confirmed'; at: number }
  | { kind: 'error' }

export interface ContinuityView {
  tone: 'healthy' | 'offline'
  compact: string
  heading: string
  detail: string
  snapshot: string
  canSnapshot: boolean
}

export function continuityView(
  connected: boolean,
  sessions: ReadonlyArray<{ alive: boolean }>,
  snapshot: SnapshotState,
): ContinuityView {
  if (!connected) {
    return {
      tone: 'offline',
      compact: 'offline',
      heading: 'Daemon disconnected',
      detail: 'Reconnecting to preserved sessions…',
      snapshot: 'Snapshot unavailable while disconnected.',
      canSnapshot: false,
    }
  }

  const live = sessions.filter((session) => session.alive).length
  const retained = sessions.length - live
  const snapshotText = snapshot.kind === 'pending'
    ? 'Saving snapshot…'
    : snapshot.kind === 'confirmed'
      ? 'Snapshot saved just now.'
      : snapshot.kind === 'error'
        ? 'Snapshot failed. Try again.'
        : 'Automatic snapshots are managed by the daemon.'

  return {
    tone: 'healthy',
    compact: `${live} live`,
    heading: 'Daemon connected',
    detail: retained > 0 ? `${live} live · ${retained} exited, retained` : `${live} live session${live === 1 ? '' : 's'}`,
    snapshot: snapshotText,
    canSnapshot: snapshot.kind !== 'pending',
  }
}
