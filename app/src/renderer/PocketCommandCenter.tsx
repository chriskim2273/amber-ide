import { piChatAvailable } from './store'
import { pocketRows } from './commandCenter'
import type { CommandCenterItem, CommandCenterModel } from './commandCenter'
import type { ProviderUsage } from '../shared/proto'
import { normalizeFriendlyTitle } from '../shared/layoutFile'
import { remaining, tightest } from '../shared/usageView'
import { shortCwd } from './tabView'
import './PocketCommandCenter.css'

export interface PocketWorkspaceOption {
  ws: number
  label: string
}

export interface PocketCommandCenterProps {
  model: CommandCenterModel
  loading: boolean
  machineName: string
  connected: boolean
  workspaceOptions: PocketWorkspaceOption[]
  activeWorkspace: number | null
  workspaceLabels: Record<number, string>
  tabLabels: Record<string, string>
  titles: Record<string, string>
  home: string
  /** Agent plan quota, as the daemon last reported it. May be empty. */
  usage: ProviderUsage[]
  onWorkspace: (workspace: number | null) => void
  onOpen: (item: CommandCenterItem) => void
  onOpenChat: (item: CommandCenterItem) => void
  onActions: (item: CommandCenterItem) => void
  onMosaic: () => void
  onDesktop: () => void
  onNew: () => void
}

function formatMemory(kib: number): string {
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`
  if (kib >= 1024) return `${Math.round(kib / 1024)} MB`
  return `${Math.max(0, Math.round(kib))} KB`
}

export function pocketSessionTitle(item: CommandCenterItem, titles: Record<string, string>, home: string): string {
  const friendly = normalizeFriendlyTitle(item.pane.title)
  if (friendly) return friendly
  const live = titles[item.pane.name]?.trim()
  if (live) return live
  const cwd = shortCwd(item.pane.cwd, home)
  const leaf = cwd.split('/').filter(Boolean).at(-1)
  if (leaf && leaf !== '~') return leaf
  return item.pane.kind.length > 0
    ? item.pane.kind[0]!.toUpperCase() + item.pane.kind.slice(1)
    : 'Session'
}

export interface PocketSessionIdentity {
  project: string
  branch?: string | undefined
  kind: string
}

/**
 * The line that answers "which session is this?" without opening it.
 *
 * A live OSC title cannot do this job: it exists only once a pane is attached
 * and rendering, and Pocket does not attach a session until it is opened —
 * which is exactly why sessions had to be opened to be recognised. Project,
 * branch and kind are all known from the daemon's session list alone.
 */
export function pocketSessionIdentity(item: CommandCenterItem, home: string): PocketSessionIdentity {
  const cwd = shortCwd(item.pane.cwd, home)
  const leaf = cwd.split('/').filter(Boolean).at(-1)
  const branch = item.pane.branch?.trim()
  return {
    project: leaf && leaf !== '~' ? leaf : '~',
    branch: branch && branch.length > 0 ? branch : undefined,
    kind: item.pane.kind,
  }
}

/**
 * The badge text, with the kind the row already shows in its chip stripped.
 *
 * `commandCenterModel` labels states for every surface, so it spells the kind
 * out ("Pi working"). Beside a `pi` chip that spends the badge's width saying
 * the same word twice and then truncates the half that carries the meaning.
 */
export function pocketBadgeLabel(item: CommandCenterItem): string {
  const kind = item.pane.kind
  if (kind.length === 0) return item.stateLabel
  const prefix = `${kind[0]!.toUpperCase()}${kind.slice(1)} `
  if (!item.stateLabel.startsWith(prefix)) return item.stateLabel
  const rest = item.stateLabel.slice(prefix.length).trim()
  return rest.length > 0 ? rest : item.stateLabel
}

export function PocketNav({ active, onSessions, onMosaic, onDesktop, onNew }: {
  active: 'sessions' | 'mosaic'
  onSessions: () => void
  onMosaic: () => void
  onDesktop: () => void
  onNew: () => void
}): JSX.Element {
  return (
    <nav className="pocket-nav" aria-label="Pocket navigation">
      <button type="button" className={active === 'sessions' ? 'active' : ''}
        aria-current={active === 'sessions' ? 'page' : undefined} onClick={onSessions}>
        <span className="pocket-nav-mark sessions" aria-hidden="true" />
        <span>Sessions</span>
      </button>
      <button type="button" className={active === 'mosaic' ? 'active' : ''}
        aria-current={active === 'mosaic' ? 'page' : undefined} onClick={onMosaic}>
        <span className="pocket-nav-mark mosaic" aria-hidden="true" />
        <span>Mosaic</span>
      </button>
      <button type="button" aria-label="Full desktop view"
        title="Show the original full desktop interface" onClick={onDesktop}>
        <span className="pocket-nav-mark desktop" aria-hidden="true" />
        <span>Desktop</span>
      </button>
      <button type="button" onClick={onNew}>
        <span className="pocket-nav-mark new" aria-hidden="true" />
        <span>New</span>
      </button>
    </nav>
  )
}

/**
 * "claude 85% left" — the tightest LIVE gauge across providers, or null when no
 * provider reports one. Null hides the row rather than showing a dead label.
 */
export function usageLine(rows: ProviderUsage[]): string | null {
  const best = tightest(rows)
  return best ? `${best.row.provider} ${Math.round(remaining(best.gauge))}% left` : null
}

export function PocketFocusHeader({
  title,
  machineName,
  stateLabel,
  piView,
  onBack,
  onActions,
  onPiView,
}: {
  title: string
  machineName: string
  stateLabel: string
  piView?: 'terminal' | 'gui'
  onBack: () => void
  onActions: () => void
  onPiView?: (view: 'terminal' | 'gui') => void
}): JSX.Element {
  return (
    <header className="pocket-focus-head">
      <button type="button" className="pocket-focus-back" aria-label="Back to Sessions" onClick={onBack}>
        <span className="pocket-back-mark" aria-hidden="true" />
        <span>Back</span>
      </button>
      <span className="pocket-focus-copy">
        <strong>{title}</strong>
        <span>{machineName} / {stateLabel}</span>
      </span>
      {piView && onPiView && <div className="pocket-focus-views" role="group" aria-label="Pi view">
        <button type="button" className="pocket-focus-view-toggle"
          aria-label="Show Pi chat" aria-pressed={piView === 'gui'}
          onClick={() => onPiView('gui')}>Chat</button>
        <button type="button" className="pocket-focus-view-toggle"
          aria-label="Show Pi terminal" aria-pressed={piView === 'terminal'}
          onClick={() => onPiView('terminal')}>Terminal</button>
      </div>}
      <button type="button" className="pocket-focus-actions" aria-label={`Actions for ${title}`} onClick={onActions}>
        <span className="pocket-more-mark" aria-hidden="true" />
      </button>
    </header>
  )
}

export function PocketCommandCenter({
  model,
  loading,
  machineName,
  connected,
  workspaceOptions,
  activeWorkspace,
  workspaceLabels,
  tabLabels,
  titles,
  home,
  usage,
  onWorkspace,
  onOpen,
  onOpenChat,
  onActions,
  onMosaic,
  onDesktop,
  onNew,
}: PocketCommandCenterProps): JSX.Element {
  return (
    <main className="pocket-command" aria-label="Amber Pocket sessions">
      <header className="pocket-machine">
        <span className="pocket-machine-mark" aria-hidden="true">A</span>
        <span className="pocket-machine-copy">
          <strong>{machineName}</strong>
          <span className={connected ? 'connected' : 'disconnected'}>
            <span className="pocket-state-dot" aria-hidden="true" />
            {connected ? 'Connected' : 'Reconnecting'}
          </span>
        </span>
        {usageLine(usage) !== null && (
          <span className="pocket-machine-usage" aria-label="Agent plan usage">{usageLine(usage)}</span>
        )}
        <span className="pocket-session-count">{model.count} session{model.count === 1 ? '' : 's'}</span>
      </header>

      <div className="pocket-workspaces" role="group" aria-label="Workspace filter">
        <button type="button" className={activeWorkspace === null ? 'active' : ''}
          aria-pressed={activeWorkspace === null} onClick={() => onWorkspace(null)}>All</button>
        {workspaceOptions.map((workspace) => (
          <button type="button" key={workspace.ws}
            className={activeWorkspace === workspace.ws ? 'active' : ''}
            aria-pressed={activeWorkspace === workspace.ws}
            onClick={() => onWorkspace(workspace.ws)}>{workspace.label}</button>
        ))}
      </div>

      <div className="pocket-command-scroll">
        {loading && (
          <section className="pocket-loading" role="status" aria-live="polite">
            <span className="pocket-loading-line wide" />
            <span className="pocket-loading-line" />
            <p>Connecting to Amber</p>
          </section>
        )}
        {!loading && model.alerts.map((alert) => (
          <div key={alert.id} className="pocket-alert" role="alert">
            <span className="pocket-alert-mark" aria-hidden="true">!</span>
            <span>{alert.text}</span>
          </div>
        ))}

        {!loading && (model.count === 0 ? (
          <section className="pocket-empty" aria-label="No sessions">
            <h1>No terminal sessions here</h1>
            <p>Create a session or choose another workspace.</p>
            <button type="button" onClick={onNew}>Create session</button>
          </section>
        ) : (() => {
          // ONE list. A row's position comes from the daemon slot only, so a
          // state change repaints its badge and never moves it. Actionable
          // sessions keep their prominence through the pinned strip above.
          const { rows, urgent } = pocketRows(model)
          return (
            <>
              {urgent.length > 0 && (
                <button type="button" className="pocket-urgent" onClick={() => onOpen(urgent[0]!)}>
                  <span className="pocket-alert-mark" aria-hidden="true">!</span>
                  <span className="pocket-urgent-copy">
                    <strong>{urgent.length} need{urgent.length === 1 ? 's' : ''} you</strong>
                    <span>{urgent.map((item) => pocketSessionTitle(item, titles, home)).join(', ')}</span>
                  </span>
                  <span className="pocket-open-arrow" aria-hidden="true" />
                </button>
              )}
              <div className="pocket-session-list">
                {rows.map((item) => {
                  const title = pocketSessionTitle(item, titles, home)
                  const identity = pocketSessionIdentity(item, home)
                  return (
                    <article key={item.pane.name} className={`pocket-session pocket-session-${item.group}`}>
                      <button type="button" className="pocket-session-open"
                        aria-label={`Open ${title}`} onClick={() => onOpen(item)}>
                        <span className={`pocket-kind pocket-kind-${item.pane.kind}`} aria-hidden="true" />
                        <span className="pocket-session-copy">
                          <span className="pocket-session-title">
                            {item.pane.slot ? <code>#{item.pane.slot}</code> : null}
                            <strong>{title}</strong>
                            {/* A quiet session is the default; a badge saying so
                                is noise that costs the identity line its width. */}
                            {item.group !== 'quiet' && (
                              <span className={`pocket-badge pocket-badge-${item.group}`}>{pocketBadgeLabel(item)}</span>
                            )}
                          </span>
                          <span className="pocket-session-ident">
                            <span className="pocket-ident-project">{identity.project}</span>
                            {identity.branch !== undefined && (
                              <span className="pocket-ident-branch" title={identity.branch}>{identity.branch}</span>
                            )}
                            <span className="pocket-ident-kind">{identity.kind}</span>
                          </span>
                        </span>
                      </button>
                      {piChatAvailable(item.pane, item.pane.deadCode ?? undefined) &&
                        <button type="button" className="pocket-session-chat"
                          aria-label={`Open chat for ${title}`} onClick={() => onOpenChat(item)}>
                          <span className="pocket-chat-mark" aria-hidden="true" />
                        </button>}
                      <button type="button" className="pocket-session-actions"
                        aria-label={`Actions for ${title}`} onClick={() => onActions(item)}>
                        <span className="pocket-more-mark" aria-hidden="true" />
                      </button>
                    </article>
                  )
                })}
              </div>
            </>
          )
        })())}
      </div>

      <PocketNav active="sessions" onSessions={() => {}} onMosaic={onMosaic}
        onDesktop={onDesktop} onNew={onNew} />
    </main>
  )
}
