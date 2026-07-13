# amber-ide App — Slice 6: Workspaces + claude panes + reconnect

> **For agentic workers:** implement task-by-task, TDD. Steps use `- [ ]`.

**Goal:** Full single-window IDE surface — a workspace switcher, claude panes (`kind=claude`), and resilient reconnect (daemon restart → banner → auto re-subscribe + re-attach, panes repaint from replayed scrollback).

**Builds on:** Slices 1–5. Worktree `~/Projects/amber-ide-app`, branch `feat/electron-app`.

## Global Constraints (carry over)
- One-way flow; pane existence from daemon events only. Bytes never touch main.
- On reconnect, re-request the full session set (authoritative resync) and re-`Attach` every visible pane; the daemon replays scrollback on attach → xterm repaints. No app-side scrollback.
- TS strict. TDD for pure/testable modules. Conventional commits, NO `Co-Authored-By`.
- Checks (RTK hook broken — node bins directly, trust exit codes): `vitest run`, `tsc -p tsconfig.json && -p tsconfig.node.json`, `electron-vite build`.

## File Structure
- Modify `app/src/client/connection.ts` + `connection.test.ts` — reconnect loop + `open` event.
- Modify `app/src/client/router.ts` + `router.test.ts` — `reattachAll()`.
- Modify `app/src/client/index.ts` — on every `open`, re-send Watch/List + `router.reattachAll()`; forward connection status to main.
- Modify `app/src/main/index.ts` — forward status to renderer (reuse the daemon-event channel).
- Modify `app/src/renderer/main.tsx` — workspace switcher, claude-pane creation, reconnect banner.

---

## Task 1: `connection.ts` — reconnect loop + `open` event

**Files:** Modify `app/src/client/connection.ts`, `app/src/client/connection.test.ts`.

**Interfaces (changed):** add `on(event: 'open', cb: () => void)`; `connect()` now auto-reconnects with exponential backoff (100ms→2s) until `close()`. `open` fires on every successful (re)connect.

- [ ] **Step 1: Failing test** — add to `connection.test.ts` (and make `FakeDaemon.listen` accept a fixed path — see Step 3):
```ts
  it('reconnects and re-opens after the daemon drops and returns', async () => {
    daemon = new FakeDaemon()
    const path = await daemon.listen()
    let opens = 0
    const conn = new Connection(path)
    conn.on('open', () => { opens += 1 })
    conn.connect()
    await waitFor(() => (opens >= 1 ? true : null))
    await daemon.close()                 // daemon drops
    daemon = new FakeDaemon()
    await daemon.listen(path)             // returns on the same socket path
    await waitFor(() => (opens >= 2 ? true : null), 5000)
    expect(opens).toBeGreaterThanOrEqual(2)
    conn.close()
  })
```
- [ ] **Step 2: Run, verify fail** — `open` event unknown / no reconnect.
- [ ] **Step 3: Implement** — update `app/src/test/fakeDaemon.ts` `listen` to accept an optional path, and `connection.ts` to reconnect. In `app/test/fakeDaemon.ts` change the signature:
```ts
  listen(fixedPath?: string): Promise<string> {
    counter += 1
    const path = fixedPath ?? join(tmpdir(), `amber-fake-${process.pid}-${counter}.sock`)
    // ...unchanged server.on('connection')...
    return new Promise((res) => this.server.listen(path, () => res(path)))
  }
```
Rewrite `app/src/client/connection.ts`:
```ts
import net from 'node:net'
import { encode, Decoder, type Frame } from '../shared/proto'

type FrameCb = (f: Frame) => void
type VoidCb = () => void

export class Connection {
  private socket: net.Socket | null = null
  private decoder = new Decoder()
  private frameCbs: FrameCb[] = []
  private openCbs: VoidCb[] = []
  private closeCbs: VoidCb[] = []
  private closed = false
  private attempt = 0

  constructor(private readonly path: string) {}

  on(event: 'frame', cb: FrameCb): void
  on(event: 'open', cb: VoidCb): void
  on(event: 'close', cb: VoidCb): void
  on(event: 'frame' | 'open' | 'close', cb: FrameCb | VoidCb): void {
    if (event === 'frame') this.frameCbs.push(cb as FrameCb)
    else if (event === 'open') this.openCbs.push(cb as VoidCb)
    else this.closeCbs.push(cb as VoidCb)
  }

  connect(): void {
    if (this.closed) return
    this.decoder = new Decoder()
    const socket = net.createConnection({ path: this.path })
    this.socket = socket
    socket.on('connect', () => { this.attempt = 0; for (const cb of this.openCbs) cb() })
    socket.on('data', (chunk: Buffer) => {
      this.decoder.feed(new Uint8Array(chunk))
      for (let f = this.decoder.next(); f; f = this.decoder.next()) for (const cb of this.frameCbs) cb(f)
    })
    socket.on('close', () => {
      for (const cb of this.closeCbs) cb()
      this.scheduleReconnect()
    })
    socket.on('error', () => { /* 'close' follows */ })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = Math.min(2000, 100 * 2 ** this.attempt)
    this.attempt += 1
    setTimeout(() => this.connect(), delay)
  }

  send(frame: Frame): void { this.socket?.write(encode(frame)) }

  close(): void { this.closed = true; this.socket?.destroy(); this.socket = null }
}
```
- [ ] **Step 4: Run, verify pass** — `npx vitest run src/client/connection.test.ts` (all, incl. the pre-existing close test — note it now also reconnects; that test drops the daemon and asserts `close` fired, which still holds).
- [ ] **Step 5: Commit** — `git commit -m "feat(app): connection auto-reconnect with backoff + open event"`

---

## Task 2: `router.reattachAll()` + utility resubscribe on open

**Files:** Modify `app/src/client/router.ts`, `app/src/client/router.test.ts`, `app/src/client/index.ts`, `app/src/main/index.ts`.

- [ ] **Step 1: Failing test** — add to `router.test.ts`:
```ts
  it('reattachAll re-sends Attach for every attached session', () => {
    const conn = new FakeConn()
    const router = new Router(conn)
    router.attach('sA', new FakePort())
    router.attach('sB', new FakePort())
    conn.sent.length = 0
    router.reattachAll()
    const attaches = conn.sent.filter((f) => f.type === 'control' && f.msg.kind === 'Attach')
    expect(attaches).toHaveLength(2)
  })
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add to `Router` in `app/src/client/router.ts`:
```ts
  reattachAll(): void {
    for (const session of this.ports.keys()) {
      this.conn.send({ type: 'control', msg: { kind: 'Attach', name: session } })
    }
  }
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Utility resubscribe + status.** In `app/src/client/index.ts`, move the connect/subscribe onto the `open` event and forward status to main. Replace the connection setup so it reads:
```ts
const conn = new Connection(resolveSocketPath(process.env))
const router = new Router(conn)
let controlPort: Electron.MessagePortMain | null = null

conn.on('frame', (f: Frame) => {
  if (f.type === 'control') controlPort?.postMessage({ frame: f })
})
conn.on('open', () => {
  controlPort?.postMessage({ status: 'connected' })
  conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
  conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  router.reattachAll()
})
conn.on('close', () => controlPort?.postMessage({ status: 'disconnected' }))
```
And in the `parentPort` `control` branch, DROP the inline `conn.connect()` + Watch/List sends (they now live in `on('open')`) but KEEP registering the control port, the create/kill command handler, and call `conn.connect()` once:
```ts
  if (msg.kind === 'control') {
    controlPort = port
    port.on('message', (e) => {
      const cmd = e.data as { cmd: 'create'; name: string; cwd: string; sessionKind: string } | { cmd: 'kill'; name: string }
      if (cmd.cmd === 'create') conn.send({ type: 'control', msg: { kind: 'Create', name: cmd.name, cwd: cmd.cwd, sessionKind: cmd.sessionKind } })
      else if (cmd.cmd === 'kill') conn.send({ type: 'control', msg: { kind: 'Kill', name: cmd.name } })
    })
    port.start()
    conn.connect()
  } else {
    router.attach(msg.session, port as unknown as PortLike)
  }
```
- [ ] **Step 6: main — forward status.** In `app/src/main/index.ts`, the existing `port1.on('message', (e) => win.webContents.send('daemon-event', e.data))` already forwards `{status}` messages too — no change needed. Verify it's present.
- [ ] **Step 7: typecheck + build clean.**
- [ ] **Step 8: Commit** — `git commit -m "feat(app): re-subscribe + reattach panes on reconnect; forward connection status"`

---

## Task 3: reconnect banner + workspace switcher + claude panes (renderer)

**Files:** Modify `app/src/renderer/main.tsx`.

- [ ] **Step 1: Implement** — apply these changes to `App` in `app/src/renderer/main.tsx`:

Add connection status state and handle `{status}` events:
```ts
  const [connected, setConnected] = useState(true)
```
In the `onDaemonEvent` handler, before `toEvent`, handle status:
```ts
    window.amber.onDaemonEvent((d) => {
      const st = (d as { status?: string }).status
      if (st === 'connected') setConnected(true)
      else if (st === 'disconnected') setConnected(false)
      const ev = toEvent(d); if (ev) dispatch(ev)
    })
```

Replace the single-workspace line with a workspace switcher. Change:
```ts
  const ws = groupSessions(state)[0]
```
to:
```ts
  const workspaces = groupSessions(state)
  const [activeWs, setActiveWs] = useState(1)
  const ws = workspaces.find((w) => w.ws === activeWs) ?? workspaces[0]
```
(Move the `useState` up with the other hooks — it must not sit after an early return. Put `const [activeWs, setActiveWs] = useState(1)` alongside `activeTab`.)

Use `activeWs` where the code currently hardcodes `ws:1` in `formatName`/`newPane` — replace every `ws: 1` with `ws: activeWs`, and `wsKey` derives from `ws?.ws ?? activeWs`.

Add a `kind` selector for new panes:
```ts
  const [kind, setKind] = useState<'shell' | 'claude'>('shell')
  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: activeWs, tab: tabId, ord, id: makeId() }), '.', kind)
```
And `onSplit` uses `kind` too (replace its `'shell'`).

Render the banner + workspace bar + kind toggle. Wrap the return so the banner sits at the top and a left rail lists workspaces:
```tsx
  const nextWs = (workspaces.reduce((m, w) => Math.max(m, w.ws), 0)) + 1
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#000', color: '#ddd' }}>
      {!connected && <div style={{ background: '#822', color: '#fff', padding: '4px 8px' }}>daemon disconnected — reconnecting…</div>}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#111', alignItems: 'center' }}>
        <span>ws:</span>
        {workspaces.map((w) => (
          <button key={w.ws} onClick={() => setActiveWs(w.ws)} style={{ fontWeight: w.ws === (ws?.ws ?? -1) ? 'bold' : 'normal' }}>{w.ws}</button>
        ))}
        <button onClick={() => { setActiveWs(nextWs); window.amber.createSession(formatName({ ws: nextWs, tab: 1, ord: 0, id: makeId() }), '.', kind); setActiveTab(1) }}>+ ws</button>
        <span style={{ marginLeft: 12 }}>new:</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'shell' | 'claude')}>
          <option value="shell">shell</option>
          <option value="claude">claude</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#222' }}>
        {tabs.map((t) => (
          <button key={t.tab} onClick={() => setActiveTab(t.tab)} style={{ fontWeight: t.tab === (tab?.tab ?? -1) ? 'bold' : 'normal' }}>tab {t.tab} ({t.panes.length})</button>
        ))}
        <button onClick={() => { newPane(nextTab, 0); setActiveTab(nextTab) }}>+ Tab</button>
        {tab && <button onClick={() => newPane(tab.tab, nextOrd)}>+ Pane</button>}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {/* ...unchanged SplitView / empty message... */}
      </div>
    </div>
  )
```
- [ ] **Step 2: typecheck + build clean.** Ensure all hooks (`useState` for activeWs/kind/connected) are declared before any early `return`, and `ws:1` no longer appears (all use `activeWs`).
- [ ] **Step 3: Commit** — `git commit -m "feat(app): workspace switcher + claude-pane creation + reconnect banner"`
- [ ] **Step 4: Manual smoke (user):** `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1 npm run dev`:
  - "new: claude" then "+ Pane" → a claude pane (needs `amber ctl doctor` to have resolved claude; if unresolved it falls back to a shell — that's expected daemon behavior).
  - "+ ws" makes a second workspace; switch between ws 1 and 2.
  - Kill the daemon (`pkill -f "amber daemon"`) → red "disconnected" banner; restart the daemon → banner clears, panes repaint from replayed scrollback.

---

## Definition of done (Slice 6)
- `connection` reconnect + `router.reattachAll` unit tests green; typecheck + build clean.
- Manual: workspace switch, claude panes, and daemon-restart reconnect (banner + repaint) all work.
- Next: Slice 7 — packaging (electron-builder, bundle `amber`, first-run install).
