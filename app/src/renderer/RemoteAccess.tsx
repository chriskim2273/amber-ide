// Remote access dialog (spec 2026-08-22 §9.5).
//
// The desktop app is a CONTROLLER of `amber web`, never its owner: the server
// is boot-managed by its own unit so closing the IDE never kills phone access.
// Everything here goes through `window.amber.web*`, which shells to
// `amber ctl web`.
//
// Security posture, which drives most of the odd-looking choices below: the
// login url grants FULL session control — the same authority as sitting at
// this machine. So the tokenised url is never held in component state longer
// than an interaction, never rendered by default, and the QR is drawn only on
// an explicit press.

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { WebStatus } from '../main/webService'

export function diagnosticRows(s: WebStatus): { label: string; ok: boolean; hint: string }[] {
  const tail = ((): { ok: boolean; hint: string } => {
    switch (s.tailscale) {
      case 'serving':
        return { ok: true, hint: `serving ${s.host}` }
      case 'serve-not-mapped':
        return { ok: false, hint: `run: tailscale serve --bg ${s.port || 7717}` }
      case 'not-logged-in':
        return { ok: false, hint: 'run: tailscale up' }
      case 'not-running':
        return { ok: false, hint: 'start the tailscaled service' }
      case 'not-installed':
        return { ok: false, hint: 'install tailscale to reach this from a phone' }
    }
  })()
  return [
    {
      label: 'service',
      ok: s.unit === 'active',
      hint: s.unit === 'active' ? `up ${s.uptimeSecs ?? 0}s` : 'not running — press Start',
    },
    { label: 'tailscale', ...tail },
    {
      label: 'daemon',
      ok: s.sessions !== null,
      hint: s.sessions === null ? 'server unreachable' : `${s.sessions} sessions`,
    },
    { label: 'token', ok: s.hasToken, hint: s.hasToken ? 'present (0600)' : 'none yet' },
  ]
}

interface Props {
  status: WebStatus | null
  onClose: () => void
  onRefresh: () => void
}

export function RemoteAccess({ status, onClose, onRefresh }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const act = useCallback(
    async (action: string): Promise<void> => {
      setBusy(action)
      setError(null)
      const r = await window.amber.webAction(action)
      setBusy(null)
      if (!r.ok) setError(r.error ?? `${action} failed`)
      // The credential changed under every device — drop anything we are
      // showing rather than displaying a url that no longer works.
      if (action === 'rotate-token') {
        setRevealed(null)
        setQr(null)
      }
      onRefresh()
    },
    [onRefresh],
  )

  // On-demand fetch: this is the ONLY path that ever brings the token into the
  // renderer, and only for as long as the user is looking at it.
  const withUrl = useCallback(async (use: (url: string) => void): Promise<void> => {
    const url = await window.amber.webUrl()
    if (url.length === 0) {
      setError('no login url — is the token present?')
      return
    }
    use(url)
  }, [])

  const rows = status ? diagnosticRows(status) : []

  return (
    // Reuses the repo's own dialog shell (`.help-overlay` / `.help-card` /
    // `.help-head`), the same one the Sessions and save/load dialogs use — the
    // first pass invented `.overlay`/`.dialog`, which matched no stylesheet and
    // rendered unstyled in the top-left corner.
    <div className="help-overlay" onClick={onClose}>
      <div
        className="help-card dialog-card remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Remote access"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="help-title">Remote access</span>
          <button className="icon-btn" aria-label="close" title="close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dialog-body">

        <p className="dialog-text">
          Runs the browser build of amber on this machine so you can reach these
          sessions from a phone or another computer. The server keeps running when
          this app is closed.
        </p>

        <div className="remote-row">
          <button className="btn" disabled={busy !== null} onClick={() => void act('start')}>
            Start
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void act('stop')}>
            Stop
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void act('restart')}>
            Restart
          </button>
          <div className="spacer" />
          <button className="btn" disabled={busy !== null} onClick={() => void act('enable')}>
            Enable at boot
          </button>
          <button className="btn" disabled={busy !== null} onClick={() => void act('disable')}>
            Disable
          </button>
        </div>

        {error !== null && <div className="remote-error">{error}</div>}

        <div className="remote-section">
          <div className="label">address</div>
          <code className="remote-url">{revealed ?? status?.url ?? '—'}</code>
          <div className="remote-row">
            <button
              className="btn"
              onClick={() =>
                revealed === null ? void withUrl(setRevealed) : setRevealed(null)
              }
            >
              {revealed === null ? 'Reveal login link' : 'Hide'}
            </button>
            <button className="btn" onClick={() => void withUrl((u) => window.amber.clipboardWrite(u))}>
              Copy login link
            </button>
            <button
              className="btn"
              onClick={() =>
                qr === null
                  ? void withUrl((u) => {
                      void QRCode.toDataURL(u, { margin: 1, width: 220 }).then(setQr)
                    })
                  : setQr(null)
              }
            >
              {qr === null ? 'Show QR' : 'Hide QR'}
            </button>
            <button className="btn" onClick={() => void window.amber.webOpenLocal()}>
              Open on this machine
            </button>
          </div>
          {(revealed !== null || qr !== null) && (
            <div className="remote-warn">
              Anyone with this link or code has full control of your sessions — the
              same as sitting at this machine.
            </div>
          )}
          {qr !== null && <img className="remote-qr" src={qr} alt="login QR code" />}
        </div>

        <div className="remote-section">
          <div className="label">checks</div>
          <ul className="remote-checks">
            {rows.map((r) => (
              <li key={r.label} className={r.ok ? 'ok' : 'bad'}>
                <span className="remote-check-mark">{r.ok ? '✓' : '✗'}</span>
                <span className="remote-check-label">{r.label}</span>
                <span className="remote-check-hint">{r.hint}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="remote-section">
          <div className="label">connected ({status?.clients.length ?? 0})</div>
          {status && status.clients.length > 0 ? (
            <ul className="remote-clients">
              {status.clients.map((c) => (
                <li key={c.id}>
                  <span className="remote-client-id">#{c.id}</span>
                  <span>{c.open ?? 'no pane open'}</span>
                  {/* Phase B (spec §2.2) fills `borrow` with a phone's borrowed grid. */}
                  <span className="remote-client-borrow">{c.borrow === null ? '—' : String(c.borrow)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="dialog-text">nothing connected</div>
          )}
        </div>

        <div className="remote-section">
          <div className="remote-row">
            <div className="label">log</div>
            <button className="btn" onClick={() => void window.amber.webLogTail().then(setLog)}>
              {log === null ? 'Load log' : 'Refresh log'}
            </button>
          </div>
          {log !== null && <pre className="remote-log">{log}</pre>}
        </div>

        {/* Its own section: rotating logs out every device, and a destructive
            control sitting inside a row of benign ones invites a misclick. */}
        <div className="remote-section">
          <div className="label">danger</div>
          <div className="remote-row">
            <button
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => {
                if (
                  window.confirm(
                    'Rotate the token? Every phone and browser signed in with the old link is logged out.',
                  )
                ) {
                  void act('rotate-token')
                }
              }}
            >
              Rotate token
            </button>
            <span className="remote-check-hint">
              invalidates every existing link, QR and signed-in device
            </span>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
