# amber-ide App — Slice 5: Split tree + geometry sidecar

> **For agentic workers:** implement task-by-task, TDD. Steps use `- [ ]`.

**Goal:** Replace the equal-columns tab layout with an interactive **binary split tree** (split H/V, drag-resize, close) whose geometry persists to an app-owned sidecar and survives relaunch, while pane existence still comes only from daemon events.

**Builds on:** Slice 4 (`store.ts`, `names.ts`, tabbed UI). Worktree `~/Projects/amber-ide-app`, branch `feat/electron-app`.

## Global Constraints (carry over)
- Pane existence/grouping from daemon events ONLY. Geometry (the split tree + ratios) is the one app-owned bit — sidecar JSON, atomic write, advisory: if missing/corrupt, fall back to equal columns in `ord` order. Grouping must reconstruct from names alone.
- TS strict. TDD for pure modules. Conventional commits, NO `Co-Authored-By`.
- Checks (RTK hook is broken — call node bins directly, trust exit codes):
  `node ./node_modules/vitest/vitest.mjs run`, `tsc --noEmit -p tsconfig.json && -p tsconfig.node.json`, `node ./node_modules/electron-vite/bin/electron-vite.js build`.

## File Structure
- Create `app/src/renderer/layout.ts` + `layout.test.ts` — pure split-tree.
- Create `app/src/shared/layoutFile.ts` + `layoutFile.test.ts` — sidecar schema + parse/fallback (pure).
- Modify `app/src/main/index.ts` — IPC `layout-load`/`layout-save` (atomic file IO).
- Modify `app/src/preload/index.ts` — expose `loadLayout`/`saveLayout`.
- Modify `app/src/renderer/main.tsx` — render a `<SplitView>` per tab from the tree; split/close/resize; reconcile with live sessions; debounced persist.
- Create `app/src/renderer/SplitView.tsx` — renders `paneRects` + drag handles.

---

## Task 1: `layout.ts` — the binary split tree (pure)

**Files:** Create `app/src/renderer/layout.ts`, `app/src/renderer/layout.test.ts`.

**Interfaces (Produces):**
```ts
export type Node =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; a: Node; b: Node } // ratio = a's fraction (0..1)
export interface Rect { x: number; y: number; w: number; h: number }
export function leaves(n: Node): string[]                                   // in-order paneIds
export function splitLeaf(n: Node, paneId: string, dir: 'h' | 'v', newId: string): Node
export function removeLeaf(n: Node, paneId: string): Node | null            // collapse parent; null if empty
export function setRatio(n: Node, path: Array<'a' | 'b'>, ratio: number): Node
export function paneRects(n: Node, area: Rect): Array<{ paneId: string; rect: Rect }>
export function handles(n: Node, area: Rect): Array<{ path: Array<'a' | 'b'>; dir: 'h' | 'v'; rect: Rect }>
export function equalColumns(paneIds: string[]): Node | null               // nested h-splits, equal ratios
export function reconcile(tree: Node | null, liveIds: string[]): Node | null // prune dead leaves, append new as columns
```
Semantics: `dir:'h'` = side-by-side (a=left, b=right); `dir:'v'` = stacked (a=top, b=bottom). `ratio` is a's fraction of the split axis.

- [ ] **Step 1: Failing test** — `layout.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { leaves, splitLeaf, removeLeaf, setRatio, paneRects, equalColumns, reconcile, type Node } from './layout'

const leaf = (id: string): Node => ({ kind: 'leaf', paneId: id })

describe('layout', () => {
  it('splits a leaf into two', () => {
    const t = splitLeaf(leaf('a'), 'a', 'h', 'b')
    expect(leaves(t)).toEqual(['a', 'b'])
    expect(t).toEqual({ kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') })
  })
  it('removes a leaf and collapses the parent to the sibling', () => {
    const t = splitLeaf(leaf('a'), 'a', 'h', 'b')
    expect(removeLeaf(t, 'a')).toEqual(leaf('b'))
    expect(removeLeaf(leaf('a'), 'a')).toBeNull()
  })
  it('setRatio updates the split on the given path', () => {
    const t = splitLeaf(leaf('a'), 'a', 'v', 'b')
    const t2 = setRatio(t, [], 0.3) as Extract<Node, { kind: 'split' }>
    expect(t2.ratio).toBeCloseTo(0.3)
  })
  it('paneRects tiles a horizontal split by ratio', () => {
    const t: Node = { kind: 'split', dir: 'h', ratio: 0.25, a: leaf('a'), b: leaf('b') }
    const r = paneRects(t, { x: 0, y: 0, w: 100, h: 40 })
    expect(r).toEqual([
      { paneId: 'a', rect: { x: 0, y: 0, w: 25, h: 40 } },
      { paneId: 'b', rect: { x: 25, y: 0, w: 75, h: 40 } },
    ])
  })
  it('equalColumns builds a fallback and reconcile prunes+appends', () => {
    const t = equalColumns(['a', 'b'])!
    expect(leaves(t)).toEqual(['a', 'b'])
    // dead 'a' pruned, new 'c' appended, 'b' kept
    const r = reconcile(t, ['b', 'c'])!
    expect(leaves(r).sort()).toEqual(['b', 'c'])
    expect(reconcile(t, [])).toBeNull()
    expect(reconcile(null, ['x'])).toEqual(leaf('x'))
  })
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `layout.ts`:
```ts
export type Node =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; dir: 'h' | 'v'; ratio: number; a: Node; b: Node }
export interface Rect { x: number; y: number; w: number; h: number }

export function leaves(n: Node): string[] {
  return n.kind === 'leaf' ? [n.paneId] : [...leaves(n.a), ...leaves(n.b)]
}

export function splitLeaf(n: Node, paneId: string, dir: 'h' | 'v', newId: string): Node {
  if (n.kind === 'leaf') {
    if (n.paneId !== paneId) return n
    return { kind: 'split', dir, ratio: 0.5, a: { kind: 'leaf', paneId }, b: { kind: 'leaf', paneId: newId } }
  }
  return { ...n, a: splitLeaf(n.a, paneId, dir, newId), b: splitLeaf(n.b, paneId, dir, newId) }
}

export function removeLeaf(n: Node, paneId: string): Node | null {
  if (n.kind === 'leaf') return n.paneId === paneId ? null : n
  const a = removeLeaf(n.a, paneId)
  const b = removeLeaf(n.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...n, a, b }
}

export function setRatio(n: Node, path: Array<'a' | 'b'>, ratio: number): Node {
  if (n.kind !== 'split') return n
  if (path.length === 0) return { ...n, ratio: Math.min(0.95, Math.max(0.05, ratio)) }
  const [head, ...rest] = path
  return head === 'a'
    ? { ...n, a: setRatio(n.a, rest, ratio) }
    : { ...n, b: setRatio(n.b, rest, ratio) }
}

export function paneRects(n: Node, area: Rect): Array<{ paneId: string; rect: Rect }> {
  if (n.kind === 'leaf') return [{ paneId: n.paneId, rect: area }]
  const [ra, rb] = splitRect(area, n.dir, n.ratio)
  return [...paneRects(n.a, ra), ...paneRects(n.b, rb)]
}

export function handles(n: Node, area: Rect): Array<{ path: Array<'a' | 'b'>; dir: 'h' | 'v'; rect: Rect }> {
  if (n.kind === 'leaf') return []
  const [ra, rb] = splitRect(area, n.dir, n.ratio)
  const T = 6
  const self = n.dir === 'h'
    ? { path: [] as Array<'a' | 'b'>, dir: n.dir, rect: { x: ra.x + ra.w - T / 2, y: area.y, w: T, h: area.h } }
    : { path: [] as Array<'a' | 'b'>, dir: n.dir, rect: { x: area.x, y: ra.y + ra.h - T / 2, w: area.w, h: T } }
  const nest = (side: 'a' | 'b', hs: ReturnType<typeof handles>) =>
    hs.map((h) => ({ ...h, path: [side, ...h.path] as Array<'a' | 'b'> }))
  return [self, ...nest('a', handles(n.a, ra)), ...nest('b', handles(n.b, rb))]
}

function splitRect(area: Rect, dir: 'h' | 'v', ratio: number): [Rect, Rect] {
  if (dir === 'h') {
    const wa = Math.round(area.w * ratio)
    return [{ ...area, w: wa }, { x: area.x + wa, y: area.y, w: area.w - wa, h: area.h }]
  }
  const ha = Math.round(area.h * ratio)
  return [{ ...area, h: ha }, { x: area.x, y: area.y + ha, w: area.w, h: area.h - ha }]
}

export function equalColumns(paneIds: string[]): Node | null {
  if (paneIds.length === 0) return null
  let tree: Node = { kind: 'leaf', paneId: paneIds[0] as string }
  for (let i = 1; i < paneIds.length; i++) {
    // append the new pane as a right column with even weighting
    tree = { kind: 'split', dir: 'h', ratio: i / (i + 1), a: tree, b: { kind: 'leaf', paneId: paneIds[i] as string } }
  }
  return tree
}

export function reconcile(tree: Node | null, liveIds: string[]): Node | null {
  const live = new Set(liveIds)
  let pruned = tree
  if (pruned) for (const id of leaves(pruned)) if (!live.has(id)) pruned = pruned ? removeLeaf(pruned, id) : null
  const present = new Set(pruned ? leaves(pruned) : [])
  const missing = liveIds.filter((id) => !present.has(id))
  for (const id of missing) {
    pruned = pruned === null
      ? { kind: 'leaf', paneId: id }
      : { kind: 'split', dir: 'h', ratio: 0.66, a: pruned, b: { kind: 'leaf', paneId: id } }
  }
  return pruned
}
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(app): binary split-tree layout (split/remove/ratio/rects/reconcile)"`

---

## Task 2: `layoutFile.ts` — sidecar schema + fallback (pure)

**Files:** Create `app/src/shared/layoutFile.ts`, `app/src/shared/layoutFile.test.ts`.

**Interfaces (Produces):**
```ts
import type { Node } from '../renderer/layout'
export const LAYOUT_VERSION = 1
export interface TabLayout { tree: Node | null }
export interface WsLayout { activeTab: number; tabs: Record<string, TabLayout> }
export interface LayoutFile { version: number; activeWorkspace: number; workspaces: Record<string, WsLayout> }
export function emptyLayout(): LayoutFile
export function parseLayout(text: string): LayoutFile   // corrupt / wrong-version -> emptyLayout()
export function serializeLayout(l: LayoutFile): string
```

- [ ] **Step 1: Failing test** — `layoutFile.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyLayout, parseLayout, serializeLayout, LAYOUT_VERSION } from './layoutFile'

describe('layoutFile', () => {
  it('round-trips a layout', () => {
    const l = emptyLayout()
    l.workspaces['1'] = { activeTab: 1, tabs: { '1': { tree: { kind: 'leaf', paneId: 'amber-1-1-0-a' } } } }
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })
  it('falls back to empty on corrupt json', () => {
    expect(parseLayout('{not json')).toEqual(emptyLayout())
  })
  it('falls back to empty on version mismatch', () => {
    expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION + 99, workspaces: {} }))).toEqual(emptyLayout())
  })
})
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `layoutFile.ts`:
```ts
import type { Node } from '../renderer/layout'

export const LAYOUT_VERSION = 1
export interface TabLayout { tree: Node | null }
export interface WsLayout { activeTab: number; tabs: Record<string, TabLayout> }
export interface LayoutFile { version: number; activeWorkspace: number; workspaces: Record<string, WsLayout> }

export function emptyLayout(): LayoutFile {
  return { version: LAYOUT_VERSION, activeWorkspace: 1, workspaces: {} }
}

export function parseLayout(text: string): LayoutFile {
  try {
    const v = JSON.parse(text) as Partial<LayoutFile>
    if (v.version !== LAYOUT_VERSION || typeof v.workspaces !== 'object' || v.workspaces === null) {
      return emptyLayout()
    }
    return {
      version: LAYOUT_VERSION,
      activeWorkspace: typeof v.activeWorkspace === 'number' ? v.activeWorkspace : 1,
      workspaces: v.workspaces as Record<string, WsLayout>,
    }
  } catch {
    return emptyLayout()
  }
}

export function serializeLayout(l: LayoutFile): string {
  return JSON.stringify(l)
}
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(app): layout sidecar schema with corrupt/version fallback"`

---

## Task 3: sidecar IO in main + preload

**Files:** Modify `app/src/main/index.ts`, `app/src/preload/index.ts`.

**Behavior:** `loadLayout()` reads `$XDG_STATE_HOME/amber-ide/ui-layout.json` (fallback `$HOME/.local/state/amber-ide/…`), parses with fallback; `saveLayout(text)` writes atomically (temp + rename).

- [ ] **Step 1: main — add IPC handlers.** In `app/src/main/index.ts` add imports at top: `import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'`. Add a path helper near `amberBinary`:
```ts
function layoutPath(): string {
  const stateHome = process.env['XDG_STATE_HOME']
  const root = stateHome && stateHome.length > 0 ? stateHome + '/amber-ide'
    : (process.env['HOME'] ?? '.') + '/.local/state/amber-ide'
  return root + '/ui-layout.json'
}
```
Inside `main()`, after the `open-pane` handler, register (use `ipcMain.handle` for request/response):
```ts
  ipcMain.handle('layout-load', async () => {
    try { return await readFile(layoutPath(), 'utf8') } catch { return null }
  })
  ipcMain.handle('layout-save', async (_e, text: string) => {
    const p = layoutPath()
    await mkdir(dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await writeFile(tmp, text)
    await rename(tmp, p)
  })
```
- [ ] **Step 2: preload — expose load/save.** In `app/src/preload/index.ts` add to the `amber` object:
```ts
  loadLayout: (): Promise<string | null> => ipcRenderer.invoke('layout-load'),
  saveLayout: (text: string): Promise<void> => ipcRenderer.invoke('layout-save', text),
```
- [ ] **Step 3: typecheck + build clean.**
- [ ] **Step 4: Commit** — `git commit -m "feat(app): atomic layout sidecar IO over IPC"`

---

## Task 4: `SplitView` + wire the tree into the tab UI

**Files:** Create `app/src/renderer/SplitView.tsx`; modify `app/src/renderer/main.tsx`.

**Behavior:** per active tab, keep a `Node | null` tree in state; on each session change reconcile it with the tab's live pane names; render panes at `paneRects`; drag handles call `setRatio`; a focused pane can split H/V; closing removes the leaf and `killSession`s. Persist the whole layout (debounced) via `saveLayout`; load on mount.

- [ ] **Step 1: Create `app/src/renderer/SplitView.tsx`:**
```tsx
import { useEffect, useRef, useState } from 'react'
import { Pane } from './Pane'
import { paneRects, handles, type Node, type Rect } from './layout'

export function SplitView(props: {
  tree: Node
  deadCodes: Record<string, number>
  onSetRatio: (path: Array<'a' | 'b'>, ratio: number) => void
  onSplit: (paneId: string, dir: 'h' | 'v') => void
  onClose: (paneId: string) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const panes = size.w > 0 ? paneRects(props.tree, size) : []
  const hs = size.w > 0 ? handles(props.tree, size) : []

  const startDrag = (path: Array<'a' | 'b'>, dir: 'h' | 'v') => (e: React.MouseEvent) => {
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const ratio = dir === 'h' ? (ev.clientX - size.x) / size.w : (ev.clientY - size.y) / size.h
      props.onSetRatio(path, ratio)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0 }}>
      {panes.map(({ paneId, rect }) => (
        <div key={paneId} style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 2, right: 2, zIndex: 3, display: 'flex', gap: 2 }}>
            <button title="split right" onClick={() => props.onSplit(paneId, 'h')}>⬌</button>
            <button title="split down" onClick={() => props.onSplit(paneId, 'v')}>⬍</button>
            <button title="close" onClick={() => props.onClose(paneId)}>×</button>
          </div>
          {props.deadCodes[paneId] !== undefined &&
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', color: '#fff', zIndex: 2, padding: 8 }}>exited {props.deadCodes[paneId]}</div>}
          <Pane session={paneId} />
        </div>
      ))}
      {hs.map((h, i) => (
        <div key={i} onMouseDown={startDrag(h.path, h.dir)}
          style={{ position: 'absolute', left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h,
                   cursor: h.dir === 'h' ? 'col-resize' : 'row-resize', zIndex: 4, background: '#444' }} />
      ))}
    </div>
  )
}
```
- [ ] **Step 2: Rewrite `app/src/renderer/main.tsx`** to own per-tab trees, reconcile with sessions, persist. Replace the file:
```tsx
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SplitView } from './SplitView'
import { initialState, reduce, groupSessions, type DaemonEvent } from './store'
import { formatName, makeId } from '../shared/names'
import { splitLeaf, removeLeaf, setRatio, reconcile, leaves, type Node } from './layout'
import { emptyLayout, parseLayout, serializeLayout, type LayoutFile } from '../shared/layoutFile'

declare global {
  interface Window {
    amber: {
      softwareGl: boolean
      onDaemonEvent: (cb: (d: unknown) => void) => void
      openPane: (session: string) => void
      createSession: (name: string, cwd: string, sessionKind: string) => void
      killSession: (name: string) => void
      loadLayout: () => Promise<string | null>
      saveLayout: (text: string) => Promise<void>
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
  const [layout, setLayout] = useState<LayoutFile>(emptyLayout)
  const [activeTab, setActiveTab] = useState(1)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    if (!bridgeReady) return
    window.amber.onDaemonEvent((d) => { const ev = toEvent(d); if (ev) dispatch(ev) })
    void window.amber.loadLayout().then((text) => { if (text) setLayout(parseLayout(text)) })
  }, [bridgeReady])

  // Debounced persist whenever the layout changes.
  useEffect(() => {
    if (!bridgeReady) return
    const id = setTimeout(() => void window.amber.saveLayout(serializeLayout(layoutRef.current)), 300)
    return () => clearTimeout(id)
  }, [layout, bridgeReady])

  const ws = groupSessions(state)[0]
  const tabs = ws?.tabs ?? []
  const tab = tabs.find((t) => t.tab === activeTab) ?? tabs[0]
  const deadCodes: Record<string, number> = {}
  tab?.panes.forEach((p) => { if (p.deadCode !== null) deadCodes[p.name] = p.deadCode })

  // Reconcile the persisted tree for this tab with its live pane set.
  const liveIds = tab?.panes.map((p) => p.name) ?? []
  const wsKey = String(ws?.ws ?? 1)
  const tabKey = String(tab?.tab ?? activeTab)
  const storedTree = layout.workspaces[wsKey]?.tabs[tabKey]?.tree ?? null
  const tree = reconcile(storedTree, liveIds)

  const putTree = useCallback((next: Node | null) => {
    setLayout((l) => {
      const w = l.workspaces[wsKey] ?? { activeTab, tabs: {} }
      return { ...l, workspaces: { ...l.workspaces, [wsKey]: { ...w, tabs: { ...w.tabs, [tabKey]: { tree: next } } } } }
    })
  }, [wsKey, tabKey, activeTab])

  useEffect(() => { if (tree && JSON.stringify(tree) !== JSON.stringify(storedTree)) putTree(tree) }, [tree, storedTree, putTree])

  if (!bridgeReady) return <p style={{ color: 'crimson', padding: 16 }}>preload bridge missing.</p>

  const nextOrd = (tab?.panes.reduce((m, p) => Math.max(m, p.ord), -1) ?? -1) + 1
  const nextTab = (tabs.reduce((m, t) => Math.max(m, t.tab), 0)) + 1
  const newPane = (tabId: number, ord: number): void =>
    window.amber.createSession(formatName({ ws: 1, tab: tabId, ord, id: makeId() }), '.', 'shell')

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#222' }}>
        {tabs.map((t) => (
          <button key={t.tab} onClick={() => setActiveTab(t.tab)}
            style={{ fontWeight: t.tab === (tab?.tab ?? -1) ? 'bold' : 'normal' }}>tab {t.tab} ({t.panes.length})</button>
        ))}
        <button onClick={() => { newPane(nextTab, 0); setActiveTab(nextTab) }}>+ Tab</button>
        {tab && <button onClick={() => newPane(tab.tab, nextOrd)}>+ Pane</button>}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {tree
          ? <SplitView tree={tree} deadCodes={deadCodes}
              onSetRatio={(path, r) => putTree(setRatio(tree, path, r))}
              onSplit={(paneId, dir) => {
                const id = makeId()
                const p = tab!
                window.amber.createSession(formatName({ ws: 1, tab: p.tab, ord: nextOrd, id }), '.', 'shell')
                putTree(splitLeaf(tree, paneId, dir, formatName({ ws: 1, tab: p.tab, ord: nextOrd, id })))
              }}
              onClose={(paneId) => { window.amber.killSession(paneId); putTree(removeLeaf(tree, paneId)) }} />
          : <p style={{ padding: 16 }}>No panes. Click “+ Pane”.</p>}
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
```
Note the `leaves` import is used by reconcile internally; if `tsc` flags it as unused here, drop it from this file's import list (keep only what `main.tsx` references: `splitLeaf, removeLeaf, setRatio, reconcile, type Node`).
- [ ] **Step 3: typecheck + build clean.** Fix any unused-import / strict errors without adding `any`.
- [ ] **Step 4: Commit** — `git commit -m "feat(app): interactive split view — split/resize/close, geometry persisted to sidecar"`
- [ ] **Step 5: Manual smoke (user):** `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1 npm run dev` → split a pane H and V; drag the divider to resize; close a pane (others reflow); quit and relaunch → the split geometry is restored; a pane created by `amber attach`/CLI appears appended as a new column.

---

## Definition of done (Slice 5)
- `layout` + `layoutFile` unit tests green; typecheck + build clean.
- Manual: splits/resizes/closes work; geometry survives relaunch; foreign panes append; missing/corrupt sidecar → equal-columns fallback.
- Next: Slice 6 — workspaces switcher + claude panes (`kind=claude`) + reconnect banner.
