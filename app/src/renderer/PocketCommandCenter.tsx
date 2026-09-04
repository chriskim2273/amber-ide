import type { CommandCenterItem, CommandCenterModel } from './commandCenter'
import type { ProviderUsage } from '../shared/proto'
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
  const friendly = item.pane.title?.trim()
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
  onBack,
  onActions,
}: {
  title: string
  machineName: string
  stateLabel: string
  onBack: () => void
  onActions: () => void
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
        <span className="pocket-session-count">{model.count} session{model.count === 1 ? '' : 's'}</span>
      </header>

      {usageLine(usage) !== null && (
        <div className="pocket-usage" aria-label="Agent plan usage">{usageLine(usage)}</div>
      )}

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
        ) : model.groups.map((group) => {
          if (group.items.length === 0 && group.id !== 'needs-you') return null
          return (
            <section key={group.id} className={`pocket-group pocket-group-${group.id}`}>
              <div className="pocket-group-head">
                <h2>{group.label}</h2>
                <span>{group.items.length}</span>
              </div>
              {group.items.length === 0
                ? <p className="pocket-clear">Nothing needs you</p>
                : <div className="pocket-session-list">
                    {group.items.map((item) => {
                      const title = pocketSessionTitle(item, titles, home)
                      const workspace = workspaceLabels[item.ws] ?? `Workspace ${item.ws}`
                      const tab = tabLabels[`${item.ws}:${item.tab}`] ?? `Tab ${item.tab}`
                      return (
                        <article key={item.pane.name} className={`pocket-session pocket-session-${group.id}`}>
                          <button type="button" className="pocket-session-open"
                            aria-label={`Open ${title}`} onClick={() => onOpen(item)}>
                            <span className={`pocket-kind pocket-kind-${item.pane.kind}`} aria-hidden="true" />
                            <span className="pocket-session-copy">
                              <span className="pocket-session-title">
                                {item.pane.slot ? <code>#{item.pane.slot}</code> : null}
                                <strong>{title}</strong>
                              </span>
                              <span className="pocket-session-state">{item.stateLabel}</span>
                              <span className="pocket-session-meta">
                                <span>{workspace}</span>
                                <span>{tab}</span>
                                {item.rssKb !== undefined && item.rssKb > 0
                                  ? <code className={item.growing ? 'growing' : ''}>{formatMemory(item.rssKb)}</code>
                                  : null}
                              </span>
                            </span>
                            <span className="pocket-open-arrow" aria-hidden="true" />
                          </button>
                          <button type="button" className="pocket-session-actions"
                            aria-label={`Actions for ${title}`} onClick={() => onActions(item)}>
                            <span className="pocket-more-mark" aria-hidden="true" />
                          </button>
                        </article>
                      )
                    })}
                  </div>}
            </section>
          )
        }))}
      </div>

      <PocketNav active="sessions" onSessions={() => {}} onMosaic={onMosaic}
        onDesktop={onDesktop} onNew={onNew} />
    </main>
  )
}
