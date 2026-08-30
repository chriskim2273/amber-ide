import { useState } from 'react'
import type { CommandCenterItem } from './commandCenter'
import './PocketSheets.css'

export type PocketSessionKind = 'shell' | 'claude' | 'grok' | 'codex' | 'opencode' | 'hermes' | 'pi'

const KINDS: ReadonlyArray<{ id: PocketSessionKind; label: string }> = [
  { id: 'shell', label: 'Shell' },
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'pi', label: 'Pi' },
]

function SheetFrame({ label, onDismiss, children }: {
  label: string
  onDismiss: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="pocket-sheet-overlay" onClick={onDismiss}>
      <section className="pocket-sheet" role="dialog" aria-modal="true" aria-label={label}
        onClick={(event) => event.stopPropagation()}>
        <div className="pocket-sheet-grip" aria-hidden="true" />
        {children}
      </section>
    </div>
  )
}

export function PocketSessionSheet({
  item,
  title,
  parked,
  onOpen,
  onTogglePark,
  onCopyCwd,
  onShowMosaic,
  onCloseSession,
  onDismiss,
}: {
  item: CommandCenterItem
  title: string
  parked: boolean
  onOpen: () => void
  onTogglePark: () => void
  onCopyCwd: () => void
  onShowMosaic: () => void
  onCloseSession: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <SheetFrame label={`Actions for ${title}`} onDismiss={onDismiss}>
      <header className="pocket-sheet-head">
        <span>
          <strong>{title}</strong>
          <code>{item.pane.cwd}</code>
        </span>
        <button type="button" onClick={onDismiss} aria-label="Close actions">Close</button>
      </header>
      <div className="pocket-sheet-actions">
        <button type="button" onClick={onOpen}>
          <strong>Open terminal</strong>
          <span>{item.stateLabel}</span>
        </button>
        {item.pane.kind !== 'shell' && (parked || item.pane.runState === 'claude') && (
          <button type="button" onClick={onTogglePark}>
            <strong>{parked ? 'Resume session' : 'Freeze session'}</strong>
            <span>{parked ? 'Continue the same conversation' : 'Free agent memory now'}</span>
          </button>
        )}
        <button type="button" onClick={onCopyCwd}>
          <strong>Copy working directory</strong>
          <span>{item.pane.cwd}</span>
        </button>
        <button type="button" onClick={onShowMosaic}>
          <strong>Show in Mosaic</strong>
          <span>Workspace {item.ws}, tab {item.tab}</span>
        </button>
        <button type="button" className="danger" onClick={onCloseSession}>
          <strong>Close session</strong>
          <span>Kills the process after confirmation</span>
        </button>
      </div>
    </SheetFrame>
  )
}

export function PocketNewSessionSheet({
  defaultKind,
  cwd,
  destination,
  onChooseCwd,
  onCreate,
  onDismiss,
}: {
  defaultKind: PocketSessionKind
  cwd: string
  destination: string
  onChooseCwd: () => void
  onCreate: (kind: PocketSessionKind) => void
  onDismiss: () => void
}): JSX.Element {
  const [selected, setSelected] = useState<PocketSessionKind>(defaultKind)
  return (
    <SheetFrame label="Create session" onDismiss={onDismiss}>
      <header className="pocket-sheet-head">
        <span>
          <strong>New session</strong>
          <small>{destination}</small>
        </span>
        <button type="button" onClick={onDismiss} aria-label="Close new session">Close</button>
      </header>
      <fieldset className="pocket-kind-grid">
        <legend>Session kind</legend>
        {KINDS.map((kind) => (
          <label key={kind.id}>
            <input type="radio" name="pocket-kind" value={kind.id}
              checked={selected === kind.id} onChange={() => setSelected(kind.id)} />
            <span>{kind.label}</span>
          </label>
        ))}
      </fieldset>
      <button type="button" className="pocket-cwd-choice" onClick={onChooseCwd}>
        <span>Working directory</span>
        <code>{cwd}</code>
      </button>
      <button type="button" className="pocket-create" onClick={() => onCreate(selected)}>
        Create {selected}
      </button>
    </SheetFrame>
  )
}
