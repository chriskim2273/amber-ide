// The local model router's control surface.
//
// Security posture, mirroring RemoteAccess:
//
// 1. **No key is ever in a polled payload.** The status the dialog renders
//    carries only `hasKey` and a `••••1234` hint. The plaintext value comes
//    from `routerRevealKey`, on a deliberate press, and is dropped from state
//    the moment the row is collapsed.
// 2. **A key field left blank means "unchanged".** The dialog never sees the
//    stored key, so it cannot round-trip one; the router matches on the
//    slot's stable `id` so a rename keeps its credential.
// 3. **Order is the failover order.** Reordering is ↑/↓ buttons rather than
//    drag: keyboard-reachable, testable, and at the 26 px target size the
//    rest of the toolbar uses.

import { useEffect, useState } from 'react'
import type { RouterSlot, RouterStatus } from '../shared/routerStatus'
import { moveSlot, slotToWire } from '../shared/routerStatus'

interface Props {
  status: RouterStatus | null
  onClose: () => void
  onRefresh: () => void
}

/** Rows for the diagnostics block. Pure, so it can be tested without a DOM. */
export function diagnosticRows(s: RouterStatus): { label: string; value: string; ok: boolean }[] {
  return [
    {
      label: 'Service',
      value:
        s.unit === 'active'
          ? 'running'
          : s.unit === 'inactive'
            ? 'not running'
            : 'unknown (no boot unit installed?)',
      ok: s.unit === 'active',
    },
    {
      label: 'Reachable',
      value: s.error ?? `yes, up ${s.uptimeSecs ?? 0}s`,
      ok: s.error === null && s.unit === 'active',
    },
    {
      label: 'Token',
      value: s.hasToken ? 'present (0600)' : 'not created yet — start the router once',
      ok: s.hasToken,
    },
    {
      label: 'Slots enabled',
      value: `${s.slots.filter((x) => x.enabled).length} of ${s.slots.length}`,
      ok: s.slots.some((x) => x.enabled),
    },
    {
      label: 'Pi provider',
      value:
        s.pi === 'installed'
          ? 'registered and current'
          : s.pi === 'stale'
            ? 'registered but out of date — re-register'
            : s.pi === 'missing'
              ? 'not registered'
              : 'no Pi config found on this machine',
      ok: s.pi === 'installed',
    },
  ]
}

function blankSlot(): RouterSlot {
  return {
    id: '',
    name: '',
    baseUrl: 'https://',
    model: '',
    enabled: true,
    hasKey: false,
    keyHint: '',
  }
}

export function RouterPanel({ status, onClose, onRefresh }: Props): JSX.Element {
  const [slots, setSlots] = useState<RouterSlot[]>([])
  // Keys the user has typed this session, by slot index. Empty means
  // "unchanged" all the way down to the router.
  const [keys, setKeys] = useState<Record<number, string>>({})
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const load = async (): Promise<void> => {
    const res = await window.amber.routerSlots()
    if (res.ok) {
      setSlots(res.slots)
      setKeys({})
      setRevealed({})
      setError(null)
    } else {
      setError(res.error ?? 'could not read the slot list')
    }
  }

  useEffect(() => {
    void load()
    // Loading once on open is deliberate: re-reading under the 3 s status poll
    // would discard whatever the user is part-way through typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (action: string): Promise<void> => {
    setBusy(true)
    const res = await window.amber.routerAction(action)
    setBusy(false)
    setError(res.ok ? null : (res.error ?? `${action} failed`))
    onRefresh()
    if (res.ok) void load()
  }

  const save = async (next: RouterSlot[], typed: Record<number, string>): Promise<void> => {
    setBusy(true)
    // Back to the wire shape: spreading the UI object would send `baseUrl`,
    // which the router's deserializer rejects for want of `base_url`.
    const payload = next.map((s, i) => slotToWire(s, typed[i] ?? ''))
    const res = await window.amber.routerSaveSlots(payload as unknown as RouterSlot[])
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'save failed')
      return
    }
    setError(null)
    await load()
    onRefresh()
  }

  const edit = (i: number, patch: Partial<RouterSlot>): void => {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }

  const move = (from: number, to: number): void => {
    const next = moveSlot(slots, from, to)
    if (next === slots) return
    // Typed keys are held by row index, so they have to move with their row —
    // otherwise a reorder would hand a half-typed key to a different provider.
    const order = slots.map((_, i) => i)
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved as number)
    const remapped: Record<number, string> = {}
    order.forEach((oldIndex, newIndex) => {
      const v = keys[oldIndex]
      if (v !== undefined) remapped[newIndex] = v
    })
    setSlots(next)
    setKeys(remapped)
    void save(next, remapped)
  }

  const reveal = async (i: number, name: string): Promise<void> => {
    if (revealed[i] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev }
        delete next[i]
        return next
      })
      return
    }
    const key = await window.amber.routerRevealKey(name)
    setRevealed((prev) => ({ ...prev, [i]: key }))
  }

  const s = status
  return (
    <div className="help-overlay" onClick={onClose}>
      <div
        className="help-card dialog-card router-dialog"
        role="dialog"
        aria-label="Model router"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <div className="help-title">Model router</div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="dialog-text">
            One OpenAI-compatible endpoint in front of every provider below, tried in order.
            Point any client on the amber host at <code>{s?.url || 'http://127.0.0.1:7719/v1'}</code> and ask for
            model <code>{s?.alias ?? 'auto'}</code>, or a slot&apos;s own name to pin it.
            The router binds loopback only — this browser never talks to it directly.
          </p>

          {error && <div className="remote-error">{error}</div>}

          <div className="remote-row">
            <button className="btn" disabled={busy} onClick={() => void act('start')}>
              Start
            </button>
            <button className="btn" disabled={busy} onClick={() => void act('stop')}>
              Stop
            </button>
            <button className="btn" disabled={busy} onClick={() => void act('restart')}>
              Restart
            </button>
            <button className="btn" disabled={busy} onClick={() => void act('enable')}>
              Enable at boot
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void act('disable')}>
              Disable
            </button>
          </div>

          <div className="remote-section">
            <div className="help-title">Slots</div>
            {slots.length === 0 && (
              <p className="dialog-text">
                No slots yet. Add one with a provider&apos;s base URL, API key and model id.
              </p>
            )}
            {slots.map((slot, i) => (
              <div className="router-slot" key={slot.id || `new-${i}`}>
                <div className="router-slot-head">
                  <span className="router-slot-ord">{i + 1}</span>
                  <input
                    className="router-input"
                    aria-label={`Slot ${i + 1} name`}
                    placeholder="name"
                    value={slot.name}
                    onChange={(e) => edit(i, { name: e.target.value })}
                  />
                  <label className="router-toggle">
                    <input
                      type="checkbox"
                      checked={slot.enabled}
                      aria-label={`Slot ${i + 1} enabled`}
                      onChange={(e) => edit(i, { enabled: e.target.checked })}
                    />
                    on
                  </label>
                  <button
                    className="icon-btn"
                    aria-label={`Move slot ${i + 1} up`}
                    disabled={i === 0 || busy}
                    onClick={() => move(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Move slot ${i + 1} down`}
                    disabled={i === slots.length - 1 || busy}
                    onClick={() => move(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Remove slot ${i + 1}`}
                    disabled={busy}
                    onClick={() => {
                      const next = slots.filter((_, j) => j !== i)
                      setSlots(next)
                      void save(next, {})
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="router-slot-body">
                  <input
                    className="router-input"
                    aria-label={`Slot ${i + 1} base URL`}
                    placeholder="https://api.example.com/v1"
                    value={slot.baseUrl}
                    onChange={(e) => edit(i, { baseUrl: e.target.value })}
                  />
                  <input
                    className="router-input"
                    aria-label={`Slot ${i + 1} model`}
                    placeholder="model id"
                    value={slot.model}
                    onChange={(e) => edit(i, { model: e.target.value })}
                  />
                  <input
                    className="router-input"
                    type="password"
                    aria-label={`Slot ${i + 1} API key`}
                    placeholder={slot.hasKey ? `${slot.keyHint} (unchanged)` : 'API key'}
                    value={keys[i] ?? ''}
                    onChange={(e) => setKeys((prev) => ({ ...prev, [i]: e.target.value }))}
                  />
                  {slot.hasKey && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void reveal(i, slot.name)}
                      aria-label={`Reveal slot ${i + 1} key`}
                    >
                      {revealed[i] === undefined ? 'Reveal' : 'Hide'}
                    </button>
                  )}
                </div>
                {revealed[i] !== undefined && (
                  <div className="router-revealed">
                    <span className="remote-warn">
                      This key grants access to your provider account.
                    </span>
                    <code>{revealed[i]}</code>
                  </div>
                )}
              </div>
            ))}
            <div className="remote-row">
              <button
                className="btn"
                disabled={busy}
                onClick={() => setSlots((prev) => [...prev, blankSlot()])}
              >
                Add slot
              </button>
              <button className="btn" disabled={busy} onClick={() => void save(slots, keys)}>
                Save
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
                Discard changes
              </button>
            </div>
          </div>

          <div className="remote-section">
            <div className="help-title">Checks</div>
            <div className="remote-checks">
              {s &&
                diagnosticRows(s).map((row) => (
                  <div className="remote-row" key={row.label}>
                    <span className={row.ok ? 'router-ok' : 'router-bad'}>●</span>
                    <span>{row.label}</span>
                    <span>{row.value}</span>
                  </div>
                ))}
            </div>
            <div className="remote-row">
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act('install-pi-provider')}
              >
                Register with Pi
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void window.amber.routerLogTail().then(setLog)}
              >
                Load log
              </button>
            </div>
            {s && s.pi !== 'no-config' && (
              <p className="dialog-text">
                In Pi: <code>pi --provider amber-router --model {s.alias}</code>
              </p>
            )}
            {s && s.keys.length > 0 && (
              <div className="remote-clients">
                {s.keys.map((k) => (
                  <div className="remote-row" key={k.label}>
                    <span>{k.label}</span>
                    <span>{k.state}</span>
                    <span>
                      {k.requests} req · {k.errors} err
                      {k.coolingSecsRemaining !== null
                        ? ` · cooling ${k.coolingSecsRemaining}s`
                        : ''}
                    </span>
                    {k.lastError && <span>{k.lastError}</span>}
                  </div>
                ))}
              </div>
            )}
            {log !== null && <pre className="router-log">{log}</pre>}
          </div>

          <div className="remote-section router-danger">
            <div className="help-title">Danger zone</div>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Rotate the router token? Pi picks it up automatically.')) {
                  void act('rotate-token')
                }
              }}
            >
              Rotate token
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
