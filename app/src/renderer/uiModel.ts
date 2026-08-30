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
  { kind: 'browser', label: 'Browser', detail: 'App-local web viewer' },
  { kind: 'editor', label: 'Editor', detail: 'App-local file editor' },
] as const

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
