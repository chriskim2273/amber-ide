# amber-ide App — Slice 4: Reducer + multi-pane tabs

> **For agentic workers:** implement task-by-task, TDD. Steps use `- [ ]`.

**Goal:** Turn the single-pane skeleton into a tabbed multi-pane workspace driven entirely by daemon events, with create/kill from the UI.

**Builds on:** Slices 1–3 (daemon protocol, proto.ts, connection/router, per-pane MessagePort, Pane.tsx). Worktree `~/Projects/amber-ide-app`, branch `feat/electron-app`.

## Global Constraints (carry over)
- One-way flow: pane existence/grouping mutates ONLY from daemon events (`Sessions`/`SessionsChanged`/`Exit`). No optimistic local create/destroy — send a control message, wait for the echo.
- Bytes never touch main. Control plane (create/kill/list) goes renderer→main→utility→daemon; data plane stays on the pane MessagePorts.
- TS strict. TDD. Conventional commits, NO `Co-Authored-By`.
- Checks: `node ./node_modules/vitest/vitest.mjs run`, `tsc --noEmit -p tsconfig.json && -p tsconfig.node.json`, `electron-vite build` — all clean. (RTK proxy is broken here; call the node bins directly.)

## File Structure
- Create `app/src/shared/names.ts` + `names.test.ts` — parse/format `amber-<ws>-<tab>-<ord>-<id>`.
- Create `app/src/renderer/store.ts` + `store.test.ts` — reducer (session set from events) + `groupSessions` selector.
- Modify `app/src/client/index.ts` — handle control-plane commands from main (`create`/`kill`) on the control port.
- Modify `app/src/main/index.ts` — `ipcMain` `daemon-command` → forward to utility control port.
- Modify `app/src/preload/index.ts` — expose `createSession`/`killSession`.
- Modify `app/src/renderer/main.tsx` — App renders a tab bar + the active tab's panes (equal columns) from the store; new-tab / new-pane / kill buttons.

---

## Task 1: `names.ts` — parse/format session names

**Files:** Create `app/src/shared/names.ts`, `app/src/shared/names.test.ts`.

**Interfaces (Produces):**
```ts
export interface PaneName { ws: number; tab: number; ord: number; id: string }
export function parseName(name: string): PaneName | null
export function formatName(p: PaneName): string   // `amber-${ws}-${tab}-${ord}-${id}`
export function makeId(): string                   // short unique-ish suffix, [a-z0-9]+
```

- [ ] **Step 1: Failing test** — `names.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseName, formatName, makeId } from './names'

describe('names', () => {
  it('parses a well-formed name', () => {
    expect(parseName('amber-1-2-0-abc')).toEqual({ ws: 1, tab: 2, ord: 0, id: 'abc' })
  })
  it('formats and round-trips', () => {
    const p = { ws: 3, tab: 1, ord: 5, id: 'x9y' }
    expect(parseName(formatName(p))).toEqual(p)
  })
  it('rejects malformed names', () => {
    for (const bad of ['', 'amber', 'amber-1-2-3', 'nope-1-2-3-x', 'amber-a-b-c-d', 'amber-1-2-3-'])
      expect(parseName(bad)).toBeNull()
  })
  it('makeId is non-empty and url-safe', () => {
    const id = makeId()
    expect(id).toMatch(/^[a-z0-9]+$/)
    expect(id.length).toBeGreaterThan(0)
  })
})
```
- [ ] **Step 2: Run, verify fail** — `cd app && npx vitest run src/shared/names.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** — `names.ts`:
```ts
export interface PaneName { ws: number; tab: number; ord: number; id: string }

const RE = /^amber-(\d+)-(\d+)-(\d+)-([A-Za-z0-9]+)$/

export function parseName(name: string): PaneName | null {
  const m = RE.exec(name)
  if (!m) return null
  return { ws: Number(m[1]), tab: Number(m[2]), ord: Number(m[3]), id: m[4] as string }
}

export function formatName(p: PaneName): string {
  return `amber-${p.ws}-${p.tab}-${p.ord}-${p.id}`
}

let counter = 0
export function makeId(): string {
  counter = (counter + 1) % 0xffff
  // Time + counter keeps ids unique within a session without crypto.
  return (Date.now().toString(36) + counter.toString(36)).replace(/[^a-z0-9]/g, '')
}
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git add app/src/shared/names.ts app/src/shared/names.test.ts && git commit -m "feat(app): session-name parse/format (amber-<ws>-<tab>-<ord>-<id>)"`

---

## Task 2: `store.ts` — reducer + grouping selector

**Files:** Create `app/src/renderer/store.ts`, `app/src/renderer/store.test.ts`.

**Interfaces (Produces):**
```ts
import type { SessionInfo } from '../shared/proto'
export interface AppState { sessions: SessionInfo[]; dead: Record<string, number>; error: string | null }
export type DaemonEvent =
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }
export interface PaneModel { name: string; cwd: string; kind: string; alive: boolean; ord: number; deadCode: number | null }
export interface TabModel { tab: number; panes: PaneModel[] }        // panes sorted by ord
export interface WorkspaceModel { ws: number; tabs: TabModel[] }     // tabs sorted by tab
export function initialState(): AppState
export function reduce(state: AppState, ev: DaemonEvent): AppState
export function groupSessions(state: AppState): WorkspaceModel[]     // sorted by ws
```

Rules the tests must pin:
- `Sessions` fully replaces the session set; clears `error`; drops `dead` entries no longer present.
- `SessionsChanged` adds (dedupe by name, added overrides existing) and removes by name (also clears their `dead`).
- `Exit` records `dead[name]=code` (pane stays until a `removed` drops it).
- `Error` sets `error`.
- `groupSessions` parses names (ignores unparseable), buckets ws→tab, sorts tabs by `tab` and panes by `ord`, sets `deadCode` from `dead`.

- [ ] **Step 1: Failing test** — `store.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, reduce, groupSessions } from './store'
import type { SessionInfo } from '../shared/proto'

const s = (name: string, alive = true): SessionInfo => ({ name, cwd: '/w', kind: 'shell', alive })

describe('store', () => {
  it('Sessions replaces the set', () => {
    let st = initialState()
    st = reduce(st, { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    expect(st.sessions.map((x) => x.name)).toEqual(['amber-1-1-0-a'])
  })
  it('SessionsChanged adds and removes', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-1-1-0-a')] })
    st = reduce(st, { kind: 'SessionsChanged', added: [s('amber-1-1-1-b')], removed: [] })
    expect(st.sessions).toHaveLength(2)
    st = reduce(st, { kind: 'SessionsChanged', added: [], removed: ['amber-1-1-0-a'] })
    expect(st.sessions.map((x) => x.name)).toEqual(['amber-1-1-1-b'])
  })
  it('Exit marks dead; groupSessions surfaces the code', () => {
    let st = reduce(initialState(), { kind: 'Sessions', sessions: [s('amber-2-3-0-a')] })
    st = reduce(st, { kind: 'Exit', name: 'amber-2-3-0-a', code: 7 })
    const ws = groupSessions(st)
    expect(ws[0]!.tabs[0]!.panes[0]!.deadCode).toBe(7)
  })
  it('groupSessions buckets ws->tab and sorts by ord', () => {
    const st = reduce(initialState(), { kind: 'Sessions', sessions: [
      s('amber-1-1-1-b'), s('amber-1-1-0-a'), s('amber-1-2-0-c'), s('amber-2-1-0-d'), s('not-a-pane'),
    ] })
    const ws = groupSessions(st)
    expect(ws.map((w) => w.ws)).toEqual([1, 2])
    expect(ws[0]!.tabs.map((t) => t.tab)).toEqual([1, 2])
    expect(ws[0]!.tabs[0]!.panes.map((p) => p.name)).toEqual(['amber-1-1-0-a', 'amber-1-1-1-b'])
  })
  it('Error sets error', () => {
    const st = reduce(initialState(), { kind: 'Error', msg: 'boom' })
    expect(st.error).toBe('boom')
  })
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `store.ts`:
```ts
import type { SessionInfo } from '../shared/proto'
import { parseName } from '../shared/names'

export interface AppState { sessions: SessionInfo[]; dead: Record<string, number>; error: string | null }
export type DaemonEvent =
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }
export interface PaneModel { name: string; cwd: string; kind: string; alive: boolean; ord: number; deadCode: number | null }
export interface TabModel { tab: number; panes: PaneModel[] }
export interface WorkspaceModel { ws: number; tabs: TabModel[] }

export function initialState(): AppState {
  return { sessions: [], dead: {}, error: null }
}

export function reduce(state: AppState, ev: DaemonEvent): AppState {
  switch (ev.kind) {
    case 'Sessions': {
      const names = new Set(ev.sessions.map((x) => x.name))
      const dead: Record<string, number> = {}
      for (const [n, c] of Object.entries(state.dead)) if (names.has(n)) dead[n] = c
      return { sessions: [...ev.sessions], dead, error: null }
    }
    case 'SessionsChanged': {
      const removed = new Set(ev.removed)
      const byName = new Map<string, SessionInfo>()
      for (const x of state.sessions) if (!removed.has(x.name)) byName.set(x.name, x)
      for (const x of ev.added) byName.set(x.name, x)
      const dead: Record<string, number> = {}
      for (const [n, c] of Object.entries(state.dead)) if (!removed.has(n) && byName.has(n)) dead[n] = c
      return { sessions: [...byName.values()], dead, error: state.error }
    }
    case 'Exit':
      return { ...state, dead: { ...state.dead, [ev.name]: ev.code } }
    case 'Error':
      return { ...state, error: ev.msg }
  }
}

export function groupSessions(state: AppState): WorkspaceModel[] {
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const sess of state.sessions) {
    const p = parseName(sess.name)
    if (!p) continue
    const pane: PaneModel = {
      name: sess.name, cwd: sess.cwd, kind: sess.kind, alive: sess.alive,
      ord: p.ord, deadCode: sess.name in state.dead ? state.dead[sess.name]! : null,
    }
    if (!wsMap.has(p.ws)) wsMap.set(p.ws, new Map())
    const tabs = wsMap.get(p.ws)!
    if (!tabs.has(p.tab)) tabs.set(p.tab, [])
    tabs.get(p.tab)!.push(pane)
  }
  return [...wsMap.entries()].sort((a, b) => a[0] - b[0]).map(([ws, tabs]) => ({
    ws,
    tabs: [...tabs.entries()].sort((a, b) => a[0] - b[0]).map(([tab, panes]) => ({
      tab, panes: panes.sort((a, b) => a.ord - b.ord),
    })),
  }))
}
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(app): store reducer + groupSessions (daemon events -> ws/tab/pane tree)"`

---

## Task 3: control-plane commands (create/kill) end to end

**Files:** Modify `app/src/client/index.ts`, `app/src/main/index.ts`, `app/src/preload/index.ts`.

**Behavior:** renderer calls `window.amber.createSession(name, cwd, kind)` / `killSession(name)` → main forwards over the control port → utility sends `Create`/`Kill` to the daemon. Pane appears/disappears via the resulting `SessionsChanged` (no optimistic update).

- [ ] **Step 1: utility — handle commands on the control port.** In `app/src/client/index.ts`, replace the control-port branch so it also accepts commands from main:
```ts
  if (msg.kind === 'control') {
    controlPort = port
    port.on('message', (e) => {
      const cmd = e.data as
        | { cmd: 'create'; name: string; cwd: string; sessionKind: string }
        | { cmd: 'kill'; name: string }
      if (cmd.cmd === 'create') {
        conn.send({ type: 'control', msg: { kind: 'Create', name: cmd.name, cwd: cmd.cwd, sessionKind: cmd.sessionKind } })
      } else if (cmd.cmd === 'kill') {
        conn.send({ type: 'control', msg: { kind: 'Kill', name: cmd.name } })
      }
    })
    port.start()
    conn.connect()
    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  } else {
    router.attach(msg.session, port as unknown as PortLike)
  }
```
- [ ] **Step 2: main — forward renderer commands to the control port.** In `app/src/main/index.ts`, after `port1.start()`, add:
```ts
  ipcMain.on('daemon-command', (_e, cmd: unknown) => port1.postMessage(cmd))
```
- [ ] **Step 3: preload — expose create/kill.** In `app/src/preload/index.ts`, extend the exposed API:
```ts
  createSession: (name: string, cwd: string, sessionKind: string) =>
    ipcRenderer.send('daemon-command', { cmd: 'create', name, cwd, sessionKind }),
  killSession: (name: string) => ipcRenderer.send('daemon-command', { cmd: 'kill', name }),
```
- [ ] **Step 4: typecheck + build** — `tsc -p tsconfig.node.json` and `electron-vite build` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(app): create/kill control-plane wiring renderer->main->utility->daemon"`

---

## Task 4: App UI — tab bar + panes + create/kill

**Files:** Modify `app/src/renderer/main.tsx`.

**Behavior:** subscribe to daemon events into the store; render the active workspace's tabs; the active tab shows its panes as equal-width columns (each a `<Pane>`); buttons: New Tab, New Pane (in active tab), Kill Pane. Names generated with `formatName`/`makeId`; `ord` = next free index in the tab.

- [ ] **Step 1: Implement** — replace `app/src/renderer/main.tsx`:
```tsx
import { useEffect, useReducer, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Pane } from './Pane'
import { initialState, reduce, groupSessions, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'

declare global {
  interface Window {
    amber: {
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
      createSession: (name: string, cwd: string, sessionKind: string) => void
      killSession: (name: string) => void
    }
  }
}

function toEvent(d: unknown): DaemonEvent | null {
  const f = (d as { frame?: { type: string; msg?: Record<string, unknown> } }).frame
  if (f?.type !== 'control' || !f.msg) return null
  const m = f.msg as { kind: string; [k: string]: unknown }
  if (m.kind === 'Sessions') return { kind: 'Sessions', sessions: m['sessions'] as never }
  if (m.kind === 'SessionsChanged') return { kind: 'SessionsChanged', added: m['added'] as never, removed: m['removed'] as never }
  if (m.kind === 'Exit') return { kind: 'Exit', name: m['name'] as string, code: m['code'] as number }
  if (m.kind === 'Error') return { kind: 'Error', msg: m['msg'] as string }
  return null
}

function App(): JSX.Element {
  const bridgeReady = typeof window.amber?.onDaemonEvent === 'function'
  const [state, dispatch] = useReducer(reduce, undefined, initialState)
  const [activeTab, setActiveTab] = useState(1)
  const cwd = '.' // daemon resolves; real cwd picker is later
  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => { const ev = toEvent(d); if (ev) dispatch(ev) })
  }, [bridgeReady])
  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  const ws = groupSessions(state)[0] // single workspace for slice 4 (ws=1)
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1

  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: 1, tab: tabId, ord, id: makeId() }), cwd, 'shell')

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#222' }}>
        {tabs.map((t) => (
          <button key={t.tab} onClick={() => setActiveTab(t.tab)}
            style={{ fontWeight: t.tab === (tab?.tab ?? -1) ? 'bold' : 'normal' }}>
            tab {t.tab} ({t.panes.length})
          </button>
        ))}
        <button onClick={() => { newPane(nextTab, 0); setActiveTab(nextTab) }}>+ Tab</button>
        {tab && <button onClick={() => newPane(tab.tab, nextOrd)}>+ Pane</button>}
      </div>
      <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
        {tab?.panes.map((p) => (
          <div key={p.name} style={{ flex: 1, position: 'relative', borderLeft: '1px solid #333' }}>
            <button onClick={() => window.amber.killSession(p.name)}
              style={{ position: 'absolute', top: 2, right: 2, zIndex: 1 }}>×</button>
            {p.deadCode !== null && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 2, padding: 8 }}>exited {p.deadCode}</div>}
            <Pane session={p.name} />
          </div>
        ))}
        {!tab && <p style={{ padding: 16 }}>No panes. Click “+ Pane”.</p>}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
```
- [ ] **Step 2: typecheck + build** clean.
- [ ] **Step 3: Commit** — `git commit -m "feat(app): tabbed multi-pane UI from the store with create/kill"`
- [ ] **Step 4: Manual smoke (user, real session):** `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1 npm run dev` → “+ Pane” spawns a shell pane; multiple panes tile as columns; “+ Tab” makes a new tab; “×” kills a pane (disappears via `SessionsChanged`); killing a pane's child shows the “exited” overlay.

---

## Definition of done (Slice 4)
- `names` + `store` unit tests green; typecheck + build clean.
- Manual: multi-pane tabs, create/kill work end-to-end via daemon events (no optimistic updates).
- Next: Slice 5 — split tree (`layout.ts`) + geometry sidecar replacing the equal-columns layout.
