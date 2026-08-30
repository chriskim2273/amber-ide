import type { KeyboardEvent } from 'react'
import type { CommandCenterItem, CommandCenterModel } from './commandCenter'
import { pocketSessionTitle } from './PocketCommandCenter'
import './DesktopAttention.css'

const COMPACT_GROUPS = new Set(['needs-you', 'working', 'parked'])

export function attentionItems(model: CommandCenterModel): CommandCenterItem[] {
  return model.groups
    .filter((group) => COMPACT_GROUPS.has(group.id))
    .flatMap((group) => group.items)
}

export function attentionNames(model: CommandCenterModel): Set<string> {
  return new Set(model.groups.find((group) => group.id === 'needs-you')?.items.map((item) => item.pane.name) ?? [])
}

function formatMemory(kib: number): string {
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)} GB`
  if (kib >= 1024) return `${Math.round(kib / 1024)} MB`
  return `${Math.max(0, Math.round(kib))} KB`
}

function moveRowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.attention-row')]
  if (rows.length === 0) return
  const current = rows.indexOf(document.activeElement as HTMLButtonElement)
  const delta = event.key === 'ArrowDown' ? 1 : -1
  const next = current < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : (current + delta + rows.length) % rows.length
  event.preventDefault()
  rows[next]!.focus()
}

export function DesktopAttention({
  model,
  titles,
  workspaceLabels,
  tabLabels,
  home,
  onOpen,
  onViewAll,
}: {
  model: CommandCenterModel
  titles: Record<string, string>
  workspaceLabels: Record<number, string>
  tabLabels: Record<string, string>
  home: string
  onOpen: (item: CommandCenterItem) => void
  onViewAll: () => void
}): JSX.Element {
  return (
    <div className="toolbar-popover attention-popover" role="dialog" aria-label="Session attention"
      onKeyDown={moveRowFocus}>
      <div className="attention-head">
        <span><strong>Session attention</strong><small>Across every workspace</small></span>
        <span className="attention-total">{attentionItems(model).length}</span>
      </div>
      <div className="attention-scroll">
        {model.groups.filter((group) => COMPACT_GROUPS.has(group.id) && group.items.length > 0).map((group) => (
          <section className={`attention-group attention-${group.id}`} key={group.id}>
            <div className="attention-group-head"><span>{group.label}</span><span>{group.items.length}</span></div>
            {group.items.map((item) => {
              const title = pocketSessionTitle(item, titles, home)
              const workspace = workspaceLabels[item.ws] ?? `Workspace ${item.ws}`
              const tab = tabLabels[`${item.ws}:${item.tab}`] ?? `Tab ${item.tab}`
              return (
                <button className="attention-row" type="button" key={item.pane.name}
                  aria-label={`Show ${title}`} onClick={() => onOpen(item)}>
                  <span className={`kind-dot ${item.pane.kind}`} aria-hidden="true" />
                  <span className="attention-row-copy">
                    <span><strong>{title}</strong>{item.pane.slot ? <code>#{item.pane.slot}</code> : null}</span>
                    <small>{item.stateLabel}</small>
                    <span className="attention-location">{workspace} / {tab}</span>
                  </span>
                  {item.rssKb !== undefined && item.rssKb > 0
                    ? <code className={`attention-memory${item.growing ? ' growing' : ''}`}>{formatMemory(item.rssKb)}</code>
                    : null}
                </button>
              )
            })}
          </section>
        ))}
      </div>
      <button className="attention-view-all" type="button" onClick={onViewAll}>View all sessions</button>
    </div>
  )
}
