// On-screen key bar (spec 2026-08-22 §5).
//
// A phone soft keyboard has no Esc, no Tab, no Ctrl and no arrows — every key a
// TUI session is driven by. Without this bar an agent pane is readable and
// nothing else.
//
// Mobile-only by mount: `SplitView` renders it when `useMobile()` is true, so
// nothing here branches on the host.

import { useState } from 'react'
import { KEY_BAR, keyBytes } from './touchInput'

export interface KeyBarTarget {
  /** Send raw bytes to the focused pane's pty. */
  send: (data: string) => void
  /** Whether the terminal is in application cursor-key mode (arrows differ). */
  appMode: () => boolean
  /** Return focus to the terminal so the soft keyboard stays up. */
  focus: () => void
}

export function KeyBar({ target }: { target: KeyBarTarget | null }): JSX.Element {
  // Sticky Ctrl: a phone cannot hold a modifier, so it latches for one key.
  const [ctrl, setCtrl] = useState(false)

  const press = (key: string): void => {
    if (key === 'ctrl') {
      setCtrl((c) => !c)
      return
    }
    if (!target) return
    const bytes = keyBytes(key, target.appMode(), ctrl)
    if (bytes) target.send(bytes)
    setCtrl(false)
    target.focus()
  }

  return (
    <div
      className="key-bar"
      role="toolbar"
      aria-label="Terminal keys"
      // A tap must never blur xterm's hidden textarea: that closes the phone
      // keyboard between every keypress. Same guard the hand-written phone UI
      // uses (assets/app.js:626).
      onPointerDown={(e) => e.preventDefault()}
    >
      {KEY_BAR.map((k) => (
        <button
          key={k.key}
          className={`key${k.wide === true ? ' wide' : ''}${k.key === 'ctrl' && ctrl ? ' armed' : ''}`}
          data-key={k.key}
          aria-label={k.key}
          aria-pressed={k.key === 'ctrl' ? ctrl : undefined}
          onClick={() => press(k.key)}
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}
