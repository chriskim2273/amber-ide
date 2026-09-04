import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PaletteEntry } from './commandPalette'
import { filterPalette } from './commandPalette'
import type { RecoveryEvent, SearchResult, SessionInfo } from '../shared/proto'
import type { CheckpointSummary } from '../shared/checkpoint'
import type { ProjectProfile } from '../shared/projectProfile'
import {
  nextPresetInputSlot, validPresetInputText,
  type PresetInputSlot, type SessionBookmark, type WorkspaceTemplate,
} from '../shared/productivity'
import { filterRecovery, type RecoveryFilter, type SearchScope } from './productivityModels'
import { Icon } from './Icon'
import { renamePanePickerEntry } from './panePicker'

function Shell({ title, label, onClose, children }: { title: string; label: string; onClose: () => void; children: ReactNode }): JSX.Element {
  return <div className="help-overlay" onMouseDown={onClose}>
    <div className="help-card dialog-card productivity-dialog" role="dialog" aria-modal="true" aria-label={label}
      onMouseDown={(event) => event.stopPropagation()}>
      <div className="help-head"><span className="help-title">{title}</span>
        <button className="icon-btn" aria-label="close" onClick={onClose}><Icon name="close" /></button></div>
      {children}
    </div>
  </div>
}

export function PaneTitleDialog(props: { current: string; onSave: (title: string) => void; onClose: () => void }): JSX.Element {
  const [value, setValue] = useState(props.current)
  return <Shell title="Friendly pane title" label="Friendly pane title" onClose={props.onClose}>
    <form className="productivity-controls" onSubmit={(event) => { event.preventDefault(); props.onSave(value) }}>
      <input autoFocus className="productivity-search" maxLength={120} placeholder="Optional title" aria-label="friendly pane title"
        value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Escape') props.onClose()
          else event.stopPropagation()
        }} />
      <button className="btn btn-accent" type="submit">Save</button>
      <button className="btn btn-ghost" type="button" onClick={() => props.onSave('')}>Clear</button>
    </form>
    <p className="productivity-hint">Titles are shown instead of live terminal or file names. Leave blank to restore the automatic title.</p>
  </Shell>
}

export function PanePickerDialog({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const matches = useMemo(() => filterPalette(entries, query), [entries, query])
  useEffect(() => setSelected(0), [query])
  const run = (entry: PaletteEntry | undefined): void => { if (entry) { onClose(); entry.run() } }
  return <Shell title="Pane picker" label="Pane picker" onClose={onClose}>
    <input autoFocus className="productivity-search" placeholder="Search panes by title, folder, or id" value={query}
      aria-label="search panes" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((n) => Math.min(Math.max(0, matches.length - 1), n + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((n) => Math.max(0, n - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); run(matches[selected]) }
      }} />
    <div className="productivity-list" role="listbox">
      {matches.map((entry, index) => <div key={entry.id} className={'productivity-row pane-picker-row' + (index === selected ? ' selected' : '')}
        role="option" aria-selected={index === selected} onMouseEnter={() => setSelected(index)}>
        <button className="pane-picker-main" onClick={() => run(entry)}>
          <strong>{entry.label}</strong><small>{entry.detail}</small>
        </button>
        {entry.rename && <button className="btn btn-ghost pane-picker-rename" onClick={(event) => {
          event.stopPropagation(); renamePanePickerEntry(entry, onClose)
        }}>Rename</button>}
      </div>)}
      {matches.length === 0 && <div className="productivity-empty">No matching pane</div>}
    </div>
  </Shell>
}

export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const matches = useMemo(() => filterPalette(entries, query), [entries, query])
  useEffect(() => setSelected(0), [query])
  const run = (entry: PaletteEntry | undefined): void => { if (entry) { onClose(); entry.run() } }
  return <Shell title="Command palette" label="Command palette" onClose={onClose}>
    <input autoFocus className="productivity-search" placeholder="Jump to a pane or run a command" value={query}
      onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((n) => Math.min(matches.length - 1, n + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((n) => Math.max(0, n - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); run(matches[selected]) }
      }} />
    <div className="productivity-list" role="listbox">
      {matches.map((entry, index) => <button key={entry.id} className={'productivity-row' + (index === selected ? ' selected' : '')}
        role="option" aria-selected={index === selected} onMouseEnter={() => setSelected(index)} onClick={() => run(entry)}>
        <strong>{entry.label}</strong><small>{entry.detail}</small>
      </button>)}
      {matches.length === 0 && <div className="productivity-empty">No matching command</div>}
    </div>
  </Shell>
}

export function GlobalSearchDialog(props: {
  onClose: () => void; onSearch: (query: string, scope: SearchScope) => void
  onPick: (result: SearchResult, query: string) => void; describe: (name: string) => string; results: SearchResult[]
  loading: boolean; error: string | null
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (query.trim()) timer.current = setTimeout(() => props.onSearch(query, scope), 200)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query, scope])
  return <Shell title="Search all scrollback" label="Global scrollback search" onClose={props.onClose}>
    <div className="productivity-controls">
      <input autoFocus className="productivity-search" placeholder="Search retained terminal output" value={query}
        onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') props.onClose() }} />
      <select aria-label="search scope" value={scope} onChange={(e) => setScope(e.target.value as SearchScope)}>
        <option value="all">all sessions</option><option value="workspace">this workspace</option><option value="tab">this tab</option>
      </select>
    </div>
    {props.error && <div className="productivity-error" role="alert">{props.error}</div>}
    <div className="productivity-list">
      {props.loading && <div className="productivity-empty">searching…</div>}
      {!props.loading && query.trim() && props.results.length === 0 && !props.error && <div className="productivity-empty">No retained matches</div>}
      {props.results.map((result, index) => <button key={`${result.name}:${result.line}:${index}`} className="productivity-row"
        onClick={() => props.onPick(result, query)}><strong>{result.preview}</strong><small>{props.describe(result.name)} · retained line {result.line}</small></button>)}
    </div>
  </Shell>
}

export function RecoveryCenter(props: {
  events: RecoveryEvent[]; sessions: SessionInfo[]; loading: boolean; error: string | null
  onRefresh: () => void; onClear: () => void; onFocus: (session: string) => void
  onRetry: (session: string) => void; onCleanup: () => void; onClose: () => void
}): JSX.Element {
  const [filter, setFilter] = useState<RecoveryFilter>('all')
  const [query, setQuery] = useState('')
  const events = filterRecovery(props.events, filter, query)
  return <Shell title="Recovery center" label="Recovery center" onClose={props.onClose}>
    <div className="productivity-controls">
      <input className="productivity-search" placeholder="Filter history" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select value={filter} onChange={(e) => setFilter(e.target.value as RecoveryFilter)}>
        <option value="all">all</option><option value="errors">errors</option><option value="lifecycle">sessions</option><option value="snapshots">snapshots</option>
      </select>
      <button className="btn btn-ghost" onClick={props.onRefresh}>Refresh</button>
      <button className="btn btn-ghost" onClick={props.onClear}>Clear</button>
    </div>
    {props.error && <div className="productivity-error">{props.error}</div>}
    <div className="productivity-list">
      {props.loading && <div className="productivity-empty">loading daemon history…</div>}
      {!props.loading && events.length === 0 && <div className="productivity-empty">No recovery events</div>}
      {events.map((event) => {
        const session = event.session ? props.sessions.find((candidate) => candidate.name === event.session) : undefined
        const canRetry = session !== undefined && ['claude', 'grok', 'codex'].includes(session.kind) && session.run_state?.includes('suspended') === true
        return <div key={`${event.at}:${event.sequence}`} className={`productivity-row static severity-${event.level}`}>
          <span><strong>{event.event.replaceAll('.', ' ')}</strong><small>{new Date(event.at * 1000).toLocaleString()} · {event.detail}{event.code === undefined ? '' : ` · code ${event.code}`}{event.session ? ` · ${event.session}` : ''}</small></span>
          {session && <span><button className="btn btn-ghost" onClick={() => props.onFocus(session.name)}>Focus</button>{canRetry && <button className="btn btn-ghost" onClick={() => props.onRetry(session.name)}>Resume</button>}<button className="btn btn-ghost" onClick={props.onCleanup}>Cleanup</button></span>}
        </div>
      })}
    </div>
  </Shell>
}

export function TemplatesDialog(props: {
  templates: WorkspaceTemplate[]; onCapture: (name: string) => void; onLoad: (template: WorkspaceTemplate) => void
  onDelete: (id: string) => void; onRename: (id: string, name: string) => void; onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  return <Shell title="Workspace templates" label="Workspace templates" onClose={props.onClose}>
    <div className="productivity-controls"><input className="productivity-search" placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn btn-accent" disabled={!name.trim()} onClick={() => { props.onCapture(name.trim()); setName('') }}>Save current workspace</button></div>
    <div className="productivity-list">
      {props.templates.length === 0 && <div className="productivity-empty">No templates yet</div>}
      {props.templates.map((template) => <div className="productivity-row static" key={template.id}><span><strong>{template.name}</strong><small>{template.doc.workspaces[0]?.tabs.length ?? 0} tabs · {new Date(template.createdAt).toLocaleDateString()}</small></span>
        <span><button className="btn btn-accent" onClick={() => props.onLoad(template)}>Create workspace</button><button className="btn btn-ghost" onClick={() => { const name = window.prompt('Template name', template.name)?.trim(); if (name) props.onRename(template.id, name) }}>Rename</button><button className="btn btn-ghost" onClick={() => props.onDelete(template.id)}>Delete</button></span></div>)}
    </div>
  </Shell>
}

export function BookmarksDialog(props: { bookmarks: Array<{ session: string; bookmark: SessionBookmark }>; onPick: (session: string, bookmark: SessionBookmark) => void; onDelete: (session: string, id: string) => void; onRename: (session: string, id: string, label: string) => void; onClose: () => void }): JSX.Element {
  return <Shell title="Bookmarks" label="Session bookmarks" onClose={props.onClose}><div className="productivity-list">
    {props.bookmarks.length === 0 && <div className="productivity-empty">No terminal bookmarks</div>}
    {props.bookmarks.map(({ session, bookmark }) => <div className="productivity-row static" key={`${session}:${bookmark.id}`}><button onClick={() => props.onPick(session, bookmark)}><strong>{bookmark.label}</strong><small>{session} · {new Date(bookmark.createdAt).toLocaleString()}</small><code>{bookmark.excerpt}</code></button><span><button className="btn btn-ghost" onClick={() => { const label = window.prompt('Bookmark label', bookmark.label)?.trim(); if (label) props.onRename(session, bookmark.id, label) }}>Rename</button><button className="btn btn-ghost" onClick={() => props.onDelete(session, bookmark.id)}>Delete</button></span></div>)}
  </div></Shell>
}

export function PresetInputsDialog(props: {
  slots: PresetInputSlot[]; targetPane: string | null; onClose: () => void
  onInsert: (entry: PresetInputSlot) => void
  onSave: (slot: number, label: string, text: string) => void
  onDelete: (slot: number) => void
}): JSX.Element {
  const [editing, setEditing] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const next = nextPresetInputSlot(props.slots)
  const begin = (entry?: PresetInputSlot): void => {
    setEditing(entry?.slot ?? null); setLabel(entry?.label ?? ''); setText(entry?.text ?? ''); setError(null)
  }
  const save = (): void => {
    const targetSlot = editing ?? next
    if (targetSlot === null) { setError('All 20 preset slots are in use.'); return }
    if (!label.trim()) { setError('Give this preset a label.'); return }
    if (!validPresetInputText(text)) {
      setError('Input must be 1–16,384 printable characters with no line breaks, tabs, or control keys.')
      return
    }
    props.onSave(targetSlot, label.trim(), text); begin()
  }
  return <Shell title={props.targetPane ? 'Insert preset input' : 'Preset input slots'} label="Preset input slots" onClose={props.onClose}>
    <p className="dialog-text">Select a slot to type it into the pane. Amber never sends Enter. Presets are stored locally in plaintext—do not save passwords or tokens.</p>
    <div className="productivity-list preset-slot-list">
      {props.slots.length === 0 && <div className="productivity-empty">No preset inputs yet</div>}
      {props.slots.map((entry) => <div className="productivity-row static" key={entry.slot}>
        {props.targetPane
          ? <button onClick={() => props.onInsert(entry)}><strong>#{entry.slot} · {entry.label}</strong><code>{entry.text}</code></button>
          : <span><strong>#{entry.slot} · {entry.label}</strong><code>{entry.text}</code></span>}
        <span><button className="btn btn-ghost" onClick={() => begin(entry)}>Edit</button>
          <button className="btn btn-ghost" onClick={() => props.onDelete(entry.slot)}>Delete</button></span>
      </div>)}
    </div>
    <div className="preset-slot-editor">
      <div className="productivity-controls">
        <input className="productivity-search" aria-label="preset label" placeholder="Label, e.g. Run tests" value={label} maxLength={80}
          onChange={(event) => { setLabel(event.target.value); setError(null) }} />
        {editing !== null && <button className="btn btn-ghost" onClick={() => begin()}>New slot</button>}
      </div>
      <textarea className="productivity-textarea" aria-label="preset input" placeholder="Text to type into the pane (Enter is never included)"
        value={text} spellCheck={false} onChange={(event) => { setText(event.target.value); setError(null) }} />
      {error && <div className="productivity-error" role="alert">{error}</div>}
      <div className="dialog-actions"><button className="btn btn-accent" disabled={editing === null && next === null}
        onClick={save}>Save slot #{editing ?? next ?? '—'}</button></div>
    </div>
  </Shell>
}

export function CheckpointsDialog(props: { checkpoints: CheckpointSummary[]; onCreate: (name: string, scope: 'one' | 'all') => void; onRestore: (id: string, replace: boolean) => void; onDelete: (id: string) => void; onClose: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'one' | 'all'>('one')
  return <Shell title="Restore points" label="Named restore points" onClose={props.onClose}>
    <div className="productivity-controls"><input className="productivity-search" placeholder="Restore point name" value={name} onChange={(e) => setName(e.target.value)} /><select value={scope} onChange={(event) => setScope(event.target.value as 'one' | 'all')}><option value="one">current workspace</option><option value="all">all workspaces</option></select><button className="btn btn-accent" disabled={!name.trim()} onClick={() => { props.onCreate(name.trim(), scope); setName('') }}>Create</button></div>
    <p className="dialog-text">Restores structure and retained scrollback into fresh sessions. It is not a process-memory checkpoint.</p>
    <div className="productivity-list">{props.checkpoints.length === 0 && <div className="productivity-empty">No restore points</div>}
      {props.checkpoints.map((point) => <div className="productivity-row static" key={point.id}><span><strong>{point.name}{point.automatic ? ' · automatic' : ''}</strong><small>{new Date(point.createdAt).toLocaleString()} · {(point.bytes / 1024 / 1024).toFixed(1)} MiB</small></span><span><button className="btn btn-accent" onClick={() => props.onRestore(point.id, false)}>Restore as new</button><button className="btn" onClick={() => props.onRestore(point.id, true)}>Replace current</button><button className="btn btn-ghost" onClick={() => props.onDelete(point.id)}>Delete</button></span></div>)}
    </div>
  </Shell>
}

export function ProjectProfileDialog(props: { loaded: { profile: ProjectProfile; root: string; resolvedCwds: string[] } | null; error: string | null; onRead: () => void; onCreate: () => void; onClose: () => void }): JSX.Element {
  return <Shell title="Project profile" label="Project local Amber profile" onClose={props.onClose}>
    {!props.loaded && <div className="dialog-body"><p className="dialog-text">Read <code>.amber.toml</code> from the selected pane folder. Profiles declare pane kinds and folders only; they cannot run commands.</p><button className="btn btn-accent" onClick={props.onRead}>Review profile</button></div>}
    {props.error && <div className="productivity-error">{props.error}</div>}
    {props.loaded && <><p className="dialog-text"><strong>{props.loaded.profile.name || 'Unnamed profile'}</strong> · {props.loaded.root}</p><div className="productivity-list">{props.loaded.profile.panes.map((pane, index) => <div className="productivity-row static" key={index}><strong>{pane.kind}</strong><small>{props.loaded!.resolvedCwds[index]} · split {pane.direction}</small></div>)}</div><div className="dialog-actions"><button className="btn btn-accent" onClick={props.onCreate}>Create workspace</button></div></>}
  </Shell>
}
