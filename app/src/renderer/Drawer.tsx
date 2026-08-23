// Mobile navigation drawer (spec 2026-08-22 §6).
//
// The desktop chrome is a workspace pill row plus a tab row — two dense
// horizontal strips that do not survive 390px. On a phone they collapse to
// `ws · tab · ☰`, and this sheet is what the ☰ opens.
//
// Mounted only when `useMobile()` is true, so nothing here branches on host.

export interface DrawerWorkspace {
  ws: number
  label: string
  active: boolean
}

export interface DrawerTab {
  tab: number
  label: string
  active: boolean
  /** Background activity dot, same signal the desktop tab row shows. */
  activity: boolean
}

export function Drawer({
  workspaces,
  tabs,
  onPickWs,
  onPickTab,
  onNewWs,
  onNewTab,
  onClose,
}: {
  workspaces: DrawerWorkspace[]
  tabs: DrawerTab[]
  onPickWs: (ws: number) => void
  onPickTab: (tab: number) => void
  onNewWs: () => void
  onNewTab: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div
        className="drawer-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Workspaces and tabs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-grip" aria-hidden="true" />

        <div className="drawer-section">
          <div className="label">workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.ws}
              className={`drawer-row${w.active ? ' active' : ''}`}
              onClick={() => {
                onPickWs(w.ws)
                onClose()
              }}
            >
              <span>{w.label}</span>
              {w.active && <span className="drawer-check">✓</span>}
            </button>
          ))}
          <button className="drawer-row ghost" onClick={() => { onNewWs(); onClose() }}>
            + new workspace
          </button>
        </div>

        <div className="drawer-section">
          <div className="label">tabs</div>
          {tabs.map((t) => (
            <button
              key={t.tab}
              className={`drawer-row${t.active ? ' active' : ''}`}
              onClick={() => {
                onPickTab(t.tab)
                onClose()
              }}
            >
              <span>{t.label}</span>
              {/* Same background-activity signal the desktop tab row carries —
                  on a phone, where only one tab is visible at a time, it is the
                  only way to see that another tab produced output. */}
              {t.activity && !t.active && <span className="drawer-dot" aria-label="activity" />}
              {t.active && <span className="drawer-check">✓</span>}
            </button>
          ))}
          <button className="drawer-row ghost" onClick={() => { onNewTab(); onClose() }}>
            + new tab
          </button>
        </div>
      </div>
    </div>
  )
}
