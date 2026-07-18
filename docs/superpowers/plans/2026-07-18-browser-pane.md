# Browser Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-viewer pane kind (`kind:'browser'`) to the amber-ide app — an Electron `<webview>` leaf owned entirely by the app-local sidecar, surviving crash/reboot/`.amberws` save-load, with zero daemon/Rust/protocol changes.

**Architecture:** A browser pane is a synthetic layout leaf `browser-<ws>-<tab>-<ord>-<id>` with no daemon session. Its grouping + URL live in a new `browsers` map on the `LayoutFile` sidecar. `groupSessions` output is merged with these browser panes (`mergeBrowsers`); their ids are fed to `reconcile` as always-live so they are never pruned. `SplitView` renders `<Browser>` (webview + URL bar) instead of `<Pane>` when `meta.kind === 'browser'`. Reboot survival is free via the already-atomic sidecar.

**Tech Stack:** Electron `<webview>` tag, React (chrome only), TypeScript strict, vitest.

## Global Constraints

- **Zero daemon/Rust, zero protocol, zero utilityProcess changes.** Browser panes never call `createSession`/`killSession` and never open a MessagePort.
- **One-way flow preserved for daemon panes.** Browser panes are the one app-owned pane class (spec §2, accepted tradeoff): sidecar-owned only; sidecar loss loses them (same class as geometry).
- **TypeScript strict + `exactOptionalPropertyTypes`.** Use conditional spreads for optional fields (never assign `undefined`), matching `layoutFile.ts`.
- **Pane id grammar:** browser ids MUST start with `browser-` and encode `browser-<ws>-<tab>-<ord>-<id>`; daemon ids stay `amber-…`. `<id>` is `makeId()` (existing).
- **Sidecar shape-guarding:** every new parsed field drops malformed entries (never throws), matching `parseFrozen`/`parseWorkspaces`.
- **Gates each slice:** `npm run typecheck` clean, `npm test` green, `npm run build` (bundle) succeeds.

## File structure

- **New:** `src/renderer/Browser.tsx` — the `<webview>` + URL-bar component. One responsibility: render/drive one embedded web view.
- **New:** `src/shared/browserName.ts` — pure browser-id format/parse + URL normalization. Testable, no React.
- **Modify:** `src/shared/layoutFile.ts` — `browsers` map on `LayoutFile` + `parseBrowsers` guard.
- **Modify:** `src/renderer/store.ts` — `paneDot`/`tabDot` `browser` case + `mergeBrowsers` (pure).
- **Modify:** `src/renderer/SplitView.tsx` — leaf render branch + `browsers` prop + `onBrowserNav`; hide terminal-only affordances for browser panes.
- **Modify:** `src/renderer/main.tsx` — `kind` selector gains `browser`; browser-create path (sidecar + tree, no daemon); merge call; URL persistence; pass `browsers`/`onBrowserNav` to SplitView.
- **Modify:** `src/main/index.ts` — `webviewTag: true` in `webPreferences`.
- **Modify:** `src/shared/workspaceFile.ts` — serialize/load `kind:'browser'` panes (Slice C).

---

## Slice A — Pure foundations (TDD)

### Task A1: Browser id + URL normalization

**Files:**
- Create: `app/src/shared/browserName.ts`
- Test: `app/src/shared/browserName.test.ts`

**Interfaces:**
- Produces:
  - `formatBrowserName(p: { ws: number; tab: number; ord: number; id: string }): string`
  - `parseBrowserName(name: string): { ws: number; tab: number; ord: number; id: string } | null`
  - `isBrowserName(name: string): boolean`
  - `normalizeUrl(input: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { formatBrowserName, parseBrowserName, isBrowserName, normalizeUrl } from './browserName'

describe('browser id', () => {
  it('round-trips', () => {
    const n = formatBrowserName({ ws: 2, tab: 3, ord: 1, id: 'abc' })
    expect(n).toBe('browser-2-3-1-abc')
    expect(parseBrowserName(n)).toEqual({ ws: 2, tab: 3, ord: 1, id: 'abc' })
  })
  it('isBrowserName distinguishes daemon names', () => {
    expect(isBrowserName('browser-1-1-0-x')).toBe(true)
    expect(isBrowserName('amber-1-1-0-x')).toBe(false)
  })
  it('rejects malformed', () => {
    expect(parseBrowserName('amber-1-1-0-x')).toBeNull()
    expect(parseBrowserName('browser-x-1-0-x')).toBeNull()
    expect(parseBrowserName('browser-1-1-0')).toBeNull()
  })
})

describe('normalizeUrl', () => {
  it('keeps schemed urls', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
  it('http for localhost/loopback host:port', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })
  it('https for a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('foo.dev/path')).toBe('https://foo.dev/path')
  })
  it('trims + returns "" for empty', () => {
    expect(normalizeUrl('  ')).toBe('')
  })
})
```

- [ ] **Step 2: Run it, expect fail** — `npm test -- browserName` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// Pure browser-pane id grammar (mirrors names.ts for daemon sessions) + address
// normalization. No React — importable from renderer + shared + node test env.

const RE = /^browser-(\d+)-(\d+)-(\d+)-(.+)$/

export function formatBrowserName(p: { ws: number; tab: number; ord: number; id: string }): string {
  return `browser-${p.ws}-${p.tab}-${p.ord}-${p.id}`
}

export function parseBrowserName(name: string): { ws: number; tab: number; ord: number; id: string } | null {
  const m = RE.exec(name)
  if (!m) return null
  return { ws: Number(m[1]), tab: Number(m[2]), ord: Number(m[3]), id: m[4]! }
}

export function isBrowserName(name: string): boolean {
  return name.startsWith('browser-') && RE.test(name)
}

// Address-bar input → a loadable URL. Already-schemed passes through. A
// localhost/loopback host:port gets http; anything else URL-shaped gets https.
// Empty/whitespace → '' (the caller shows a blank webview). No search fallback.
export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (s === '') return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s // has a scheme (http:, https:, about:, file:)
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)
  return (isLoopback ? 'http://' : 'https://') + s
}
```

- [ ] **Step 4: Run it, expect PASS** — `npm test -- browserName`.

- [ ] **Step 5: Commit** — `git add app/src/shared/browserName.* && git commit -m "feat(app): browser-pane id grammar + url normalization"`

---

### Task A2: `browsers` map on the layout sidecar

**Files:**
- Modify: `app/src/shared/layoutFile.ts`
- Test: `app/src/shared/layoutFile.test.ts` (add cases; create if absent)

**Interfaces:**
- Produces: `BrowserEntry { ws: number; tab: number; ord: number; url: string }`; `LayoutFile.browsers?: Record<string, BrowserEntry>`; parse drops malformed entries.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseLayout, serializeLayout, type LayoutFile } from './layoutFile'

describe('layout browsers map', () => {
  it('round-trips valid entries', () => {
    const l: LayoutFile = { version: 1, activeWorkspace: 1, workspaces: {},
      browsers: { 'browser-1-1-0-a': { ws: 1, tab: 1, ord: 0, url: 'https://x.dev' } } }
    const back = parseLayout(serializeLayout(l))
    expect(back.browsers).toEqual(l.browsers)
  })
  it('drops malformed entries, keeps valid', () => {
    const text = JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, browsers: {
      ok: { ws: 1, tab: 1, ord: 0, url: 'https://a' },
      badUrl: { ws: 1, tab: 1, ord: 0, url: 5 },
      badWs: { ws: 'x', tab: 1, ord: 0, url: 'https://b' },
      notObj: 42,
    } })
    expect(parseLayout(text).browsers).toEqual({ ok: { ws: 1, tab: 1, ord: 0, url: 'https://a' } })
  })
  it('non-object browsers → undefined', () => {
    expect(parseLayout(JSON.stringify({ version: 1, activeWorkspace: 1, workspaces: {}, browsers: [] })).browsers).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, expect fail** — `npm test -- layoutFile` → FAIL.

- [ ] **Step 3: Implement** — add to `layoutFile.ts`:

```ts
export interface BrowserEntry { ws: number; tab: number; ord: number; url: string }
```

Add `browsers?: Record<string, BrowserEntry>` to the `LayoutFile` interface. Add the guard (mirrors `parseFrozen`):

```ts
function parseBrowsers(v: unknown): Record<string, BrowserEntry> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, BrowserEntry> = {}
  for (const [name, e] of Object.entries(v)) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const { ws, tab, ord, url } = e as Record<string, unknown>
    if (typeof ws === 'number' && typeof tab === 'number' && typeof ord === 'number' && typeof url === 'string'
        && Number.isFinite(ws) && Number.isFinite(tab) && Number.isFinite(ord)) {
      out[name] = { ws, tab, ord, url }
    }
  }
  return out
}
```

In `parseLayout`'s return object, add a conditional spread beside the `frozen` one:

```ts
      ...((): { browsers?: Record<string, BrowserEntry> } => {
        const b = parseBrowsers(v.browsers)
        return b ? { browsers: b } : {}
      })(),
```

- [ ] **Step 4: Run it, expect PASS** — `npm test -- layoutFile`.

- [ ] **Step 5: Commit** — `git commit -am "feat(app): layout sidecar browsers map (parse/guard/round-trip)"`

---

### Task A3: `mergeBrowsers` + `browser` kind dot

**Files:**
- Modify: `app/src/renderer/store.ts`
- Test: `app/src/renderer/store.test.ts` (add cases)

**Interfaces:**
- Consumes: `WorkspaceModel[]` (from `groupSessions`), `BrowserEntry` map.
- Produces: `mergeBrowsers(workspaces: WorkspaceModel[], browsers: Record<string, BrowserEntry>): WorkspaceModel[]` — injects a `PaneModel{kind:'browser', alive:true}` per browser entry into its `{ws,tab}`, creating ws/tab entries as needed, panes re-sorted by `ord`. `paneDot`/`tabDot` return a `browser` dot for `kind==='browser'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { mergeBrowsers, paneDot } from './store'

describe('mergeBrowsers', () => {
  it('injects a browser pane into an existing tab, sorted by ord', () => {
    const ws = [{ ws: 1, tabs: [{ tab: 1, panes: [
      { name: 'amber-1-1-0-a', cwd: '/', kind: 'shell', alive: true, ord: 0, deadCode: null }] }] }]
    const out = mergeBrowsers(ws as never, { 'browser-1-1-1-b': { ws: 1, tab: 1, ord: 1, url: 'https://x' } })
    const panes = out[0]!.tabs[0]!.panes
    expect(panes.map((p) => p.name)).toEqual(['amber-1-1-0-a', 'browser-1-1-1-b'])
    expect(panes[1]!.kind).toBe('browser')
    expect(panes[1]!.alive).toBe(true)
  })
  it('creates a ws/tab for a browser-only grouping', () => {
    const out = mergeBrowsers([], { 'browser-2-1-0-c': { ws: 2, tab: 1, ord: 0, url: 'https://y' } })
    expect(out[0]!.ws).toBe(2)
    expect(out[0]!.tabs[0]!.panes[0]!.name).toBe('browser-2-1-0-c')
  })
})

describe('paneDot browser', () => {
  it('is a browser dot', () => {
    expect(paneDot('browser', undefined)).toEqual({ cls: 'browser', label: 'browser' })
  })
})
```

- [ ] **Step 2: Run it, expect fail** — `npm test -- store` → FAIL.

- [ ] **Step 3: Implement** — in `store.ts`:

Add `import type { BrowserEntry } from '../shared/layoutFile'`. In `paneDot`, before the `if (kind !== 'claude')` line, add:

```ts
  if (kind === 'browser') return { cls: 'browser', label: 'browser' }
```

In `tabDot`, at the top, treat browser-only tabs: leave the existing logic (a browser pane is not a claude, so `claudes.length===0` already yields a `shell` dot — acceptable; the browser dot is per-pane). No change needed to `tabDot` unless a distinct tab dot is wanted (out of scope).

Add:

```ts
// Inject app-local browser panes (sidecar-owned, no daemon session) into the
// grouped model so they flow through deriveTab exactly like a daemon pane. A
// browser pane's {ws,tab} may be a grouping that has no daemon session at all,
// so ws/tab entries are created on demand. Result stays sorted by ord.
export function mergeBrowsers(workspaces: WorkspaceModel[], browsers: Record<string, BrowserEntry>): WorkspaceModel[] {
  const entries = Object.entries(browsers)
  if (entries.length === 0) return workspaces
  const wsMap = new Map<number, Map<number, PaneModel[]>>()
  for (const w of workspaces) {
    const tabs = new Map<number, PaneModel[]>()
    for (const t of w.tabs) tabs.set(t.tab, [...t.panes])
    wsMap.set(w.ws, tabs)
  }
  for (const [name, b] of entries) {
    if (!wsMap.has(b.ws)) wsMap.set(b.ws, new Map())
    const tabs = wsMap.get(b.ws)!
    if (!tabs.has(b.tab)) tabs.set(b.tab, [])
    tabs.get(b.tab)!.push({ name, cwd: '', kind: 'browser', alive: true, ord: b.ord, deadCode: null })
  }
  return [...wsMap.entries()].sort((a, b) => a[0] - b[0]).map(([ws, tabs]) => ({
    ws,
    tabs: [...tabs.entries()].sort((a, b) => a[0] - b[0]).map(([tab, panes]) => ({
      tab, panes: panes.sort((a, b) => a.ord - b.ord),
    })),
  }))
}
```

- [ ] **Step 4: Run it, expect PASS** — `npm test -- store`.

- [ ] **Step 5: Commit** — `git commit -am "feat(app): mergeBrowsers + browser kind-dot"`

---

## Slice B — Renderer wiring (component tests deferred; manual GUI verify)

### Task B1: Enable the webview tag

**Files:** Modify `app/src/main/index.ts` (`webPreferences`, ~line 317).

- [ ] **Step 1:** Add `webviewTag: true,` to the `webPreferences` object (keep `contextIsolation:true`, `nodeIntegration:false`).
- [ ] **Step 2:** `npm run typecheck` clean.
- [ ] **Step 3: Commit** — `git commit -am "feat(app): enable webviewTag for browser panes"`

### Task B2: `Browser.tsx` component

**Files:** Create `app/src/renderer/Browser.tsx`.

**Interfaces:**
- Consumes: `{ paneId: string; url: string; active: boolean; onNav: (paneId: string, url: string) => void; onTitle: (paneId: string, title: string) => void }`.
- Produces: a URL bar (back ‹ / forward › / reload ⟳ / editable address) above an Electron `<webview>` filling the body.

**Implementation notes (concrete):**
- Use a `ref` to the `<webview>` DOM element (`Electron.WebviewTag`). Declare the JSX intrinsic: add `app/src/renderer/webview.d.ts` with a `webview` element typing (partition, src, allowpopups) — an ambient module augmentation of `React.JSX.IntrinsicElements`.
- `<webview>` attributes: `partition="persist:amber-browser"`, `src={url || 'about:blank'}`, `allowpopups={false}`, style `flex:1; width:100%`.
- Address bar: controlled `<input>` seeded from `url`; on Enter, `onNav(paneId, normalizeUrl(input))` and `webview.loadURL(normalized)`.
- Wire listeners in `useEffect`: `did-navigate` / `did-navigate-in-page` → `onNav(paneId, e.url)` (persist actual URL); `page-title-updated` → `onTitle(paneId, e.title)`. `setWindowOpenHandler` isn't available on `<webview>`; instead handle `new-window` (deprecated) via the `will-navigate`/`did-create-window` guard — simplest: set `allowpopups={false}` and add a `new-window` listener that calls `window.amber.openExternal(e.url)` (add a tiny preload passthrough to `shell.openExternal`).
- Back/forward/reload buttons call `webview.goBack()/goForward()/reload()`.

- [ ] **Step 1:** Add preload passthrough `openExternal(url:string)` → main `ipcMain.handle` → `shell.openExternal(url)`; type it on `window.amber`.
- [ ] **Step 2:** Write `webview.d.ts` intrinsic typing.
- [ ] **Step 3:** Write `Browser.tsx` per notes above.
- [ ] **Step 4:** `npm run typecheck` clean; `npm run build` succeeds.
- [ ] **Step 5: Commit** — `git commit -am "feat(app): Browser webview component + openExternal bridge"`

### Task B3: Render branch + props in `SplitView`

**Files:** Modify `app/src/renderer/SplitView.tsx`.

**Interfaces:**
- Consumes new props: `browsers: Record<string, { url: string }>`, `onBrowserNav: (paneId: string, url: string) => void`.
- In the leaf map (line ~559 `.pane-body`): `if (meta?.kind === 'browser')` render `<Browser paneId={paneId} url={props.browsers[paneId]?.url ?? ''} active={props.active && !hidden} onNav={props.onBrowserNav} onTitle={(id,t)=>props.onPaneTitle(id,t)} />` instead of `<Pane>`.
- Hide terminal-only header buttons (⟳ refresh, ↺claude, split uses same) and the FindBar for browser panes. Keep move/split/close/zoom (they operate on the tree generically). Freeze on a browser: keep the overlay (blurs + blocks) — the webview sits under it.

- [ ] **Step 1:** Add the two props to `SplitViewProps`; branch the leaf body; guard `findPane`/search UI with `meta?.kind !== 'browser'`.
- [ ] **Step 2:** `npm run typecheck` + `npm test` (existing SplitView-adjacent pure tests still green).
- [ ] **Step 3: Commit** — `git commit -am "feat(app): SplitView renders Browser for kind=browser panes"`

### Task B4: `main.tsx` — create/merge/persist wiring

**Files:** Modify `app/src/renderer/main.tsx`.

**Concrete changes:**
1. `kind` state type → `'shell' | 'claude' | 'browser'`; the `<select>` (line ~678) gains `<option value="browser">browser</option>`; cast updated.
2. After `const workspaces = groupSessions(state)` (line 251): `const workspaces = mergeBrowsers(groupSessions(state), layout.browsers ?? {})`.
3. New browser-create helper (no daemon):

```ts
const newBrowser = (wsN: number, tabN: number, ord: number): string => {
  const name = formatBrowserName({ ws: wsN, tab: tabN, ord, id: makeId() })
  setLayout((l) => ({ ...l, browsers: { ...(l.browsers ?? {}), [name]: { ws: wsN, tab: tabN, ord, url: '' } } }))
  return name
}
```

   - `newPane`/`startPane`/`onSplit`/`+ ws` branch on `kind === 'browser'`: call `newBrowser(...)` then place the leaf immediately via `putTree(splitLeaf(...))` or set the tab tree to a lone leaf (no daemon round-trip, so NOT via `pending`).
4. URL persistence: pass `onBrowserNav={(id,url)=>setLayout((l)=>({ ...l, browsers: { ...(l.browsers??{}), [id]: { ...(l.browsers?.[id] ?? {ws:0,tab:0,ord:0}), url } } }))}` — but preserve existing ws/tab/ord (they exist). The 300ms debounce (line 247) auto-saves.
5. Close a browser pane: `onClose` must branch — if `isBrowserName(paneId)`, remove from `layout.browsers` + `putTree(removeLeaf(...))` instead of `killSession`.
6. `reconcile`/`deriveTab`: browser ids arrive in `d.panes` (via mergeBrowsers) so they're already in `liveIds` → kept. Verify the load-fix reconcile (line ~441 `liveForFix`) includes browser names — add browser names to `liveForFix` so a browser leaf isn't pruned as "dead".
7. Pass `browsers={Object.fromEntries(Object.entries(layout.browsers ?? {}).map(([k,v])=>[k,{url:v.url}]))}` to each `<SplitView>`.
8. `freezePane` (line ~351) reads `sessionsRef` for claude-ness — a browser name isn't there, so it's treated as non-claude (no daemon suspend). Correct — freeze on a browser is display-only.

- [ ] **Step 1:** Apply changes 1–8.
- [ ] **Step 2:** `npm run typecheck` + `npm run build`.
- [ ] **Step 3: Commit** — `git commit -am "feat(app): create/persist/close browser panes (app-local, no daemon)"`

### Task B5: Kind-dot CSS + manual GUI verify

**Files:** Modify `app/src/renderer/theme.css` (add `.kind-dot.browser` — a globe/blue token).

- [ ] **Step 1:** Add `.kind-dot.browser { background: var(--accent-blue, #4aa3ff); }` (reuse an existing token if present).
- [ ] **Step 2:** Manual GUI verify (kernel-6.17 box: `AMBER_SOFTWARE_GL=1 AMBER_NO_SANDBOX=1`): create a browser pane, load `localhost:<devport>`, split beside a shell, close app, reopen → URL restored. Note results in the build-status entry.
- [ ] **Step 3: Commit** — `git commit -am "feat(app): browser kind-dot style"`

---

## Slice C — Workspace `.amberws` save/load (TDD)

### Task C1: Serialize + load browser panes

**Files:**
- Modify: `app/src/shared/workspaceFile.ts`
- Test: `app/src/shared/workspaceFile.test.ts` (add cases)

**Design:** a browser pane serializes as `WsPane{ kind:'browser', cwd:'', ord, scrollback:'', url }` — extend `WsPane` with `url?: string`. On load it must NOT enter `creates` (no daemon session); instead `buildLoadPlan` emits a `browsers` map entry keyed by a minted `browser-…` id.

**Interfaces:**
- `WsPane` gains `url?: string`.
- `assembleSave` input `SavePane` gains optional `url?: string`; a `SavePane` with `kind:'browser'` emits a browser `WsPane`.
- `LoadPlan` gains `browsers: Record<string, BrowserEntry>`; `buildLoadPlan` routes `kind:'browser'` panes there (minting a `formatBrowserName` id) instead of `creates`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { assembleSave, planLoad } from './workspaceFile'

describe('browser panes in .amberws', () => {
  it('save emits a browser pane with url, no scrollback', () => {
    const doc = assembleSave('one',
      [{ ws: 1, tabs: [{ tab: 1, panes: [{ name: 'browser-1-1-0-a', cwd: '', kind: 'browser', ord: 0, url: 'https://x.dev' }] }] }],
      { version: 1, activeWorkspace: 1, workspaces: { '1': { activeTab: 1, tabs: { '1': { tree: { kind: 'leaf', paneId: 'browser-1-1-0-a' } } } } } },
      {})
    const pane = doc.workspaces[0]!.tabs[0]!.panes[0]!
    expect(pane.kind).toBe('browser')
    expect(pane.url).toBe('https://x.dev')
    expect(pane.scrollback).toBe('')
  })
  it('load routes a browser pane to browsers, not creates', () => {
    const doc = { version: 1, scope: 'one' as const, workspaces: [{ tabs: [{ tab: 1, tree: { kind: 'leaf' as const, paneId: 'p0' },
      panes: [{ id: 'p0', kind: 'browser', cwd: '', ord: 0, scrollback: '', url: 'https://y.dev' }] }] }] }
    let n = 0
    const plan = planLoad(doc, { mode: 'new', currentWs: 1, liveWs: [1], mintId: () => `m${n++}` })
    expect(plan.creates).toEqual([])
    const [name, entry] = Object.entries(plan.browsers)[0]!
    expect(name.startsWith('browser-2-1-0-')).toBe(true)
    expect(entry).toEqual({ ws: 2, tab: 1, ord: 0, url: 'https://y.dev' })
  })
})
```

- [ ] **Step 2: Run it, expect fail** — `npm test -- workspaceFile` → FAIL.

- [ ] **Step 3: Implement**
  - Add `url?: string` to `WsPane`; in `parsePane` add `...(typeof p['url'] === 'string' ? { url: p['url'] } : {})`.
  - Add `url?: string` to `SavePane`; in `assembleSave`'s pane map, when `p.kind === 'browser'` set `url: p.url ?? ''` (conditional spread) and leave `scrollback:''`.
  - Add `browsers: Record<string, BrowserEntry>` to `LoadPlan`; init `const browsers = {}`; in `buildLoadPlan`'s pane loop, `if (pane.kind === 'browser') { const name = formatBrowserName({ ws: targetWs, tab: tab.tab, ord: pane.ord, id: opts.mintId() }); idToName[pane.id] = name; browsers[name] = { ws: targetWs, tab: tab.tab, ord: pane.ord, url: pane.url ?? '' }; continue }` (skip the `creates.push`). Return `browsers`. In `planLoad`, merge `browsers` across firstPlan/restPlan like the other maps. Import `formatBrowserName`, `BrowserEntry`.

- [ ] **Step 4: Run it, expect PASS** — `npm test -- workspaceFile`.

- [ ] **Step 5: Commit** — `git commit -am "feat(app): .amberws save/load of browser panes"`

### Task C2: `main.tsx` save/load browser wiring

**Files:** Modify `app/src/renderer/main.tsx`.

**Concrete changes:**
- `doSave` (assemble): include browser panes as `SavePane{kind:'browser', url}` from `layout.browsers` for the saved ws/tabs (mergeBrowsers already put them in `workspaces`; map their `layout.browsers[name].url` into the SavePane).
- `commitLoad` / `pendingLoad`: apply `plan.browsers` into `layout.browsers` alongside `plan.workspaces`. Browser panes have no daemon session, so the `pendingLoad` "all created sessions confirmed" gate must NOT wait on them (they're already live from the app's view) — only `plan.creates` (daemon) gate the commit.

- [ ] **Step 1:** Apply. `npm run typecheck` + `npm test` + `npm run build`.
- [ ] **Step 2:** Manual GUI verify: save a workspace containing a browser pane → reload into a new workspace → URL + placement restored.
- [ ] **Step 3: Commit** — `git commit -am "feat(app): wire browser panes through workspace save/load"`

---

## Self-review notes

- **Spec coverage:** §3 (A2), §4 (A3 + B4.2/6), §5 (B1/B2/B3), §6 (B4.1/3), §7 (A2 reboot + Slice C), §8 (B1/B2 sandbox + openExternal), §9 (A1 normalizeUrl), §10 (B3 hidden affordances), §11 (Global Constraints), §12 (A1/A2/A3/C1 tests).
- **Type consistency:** `BrowserEntry` defined in A2, reused in A3/C1; `formatBrowserName`/`isBrowserName`/`normalizeUrl` from A1 used in B2/B4/C1; `mergeBrowsers` from A3 used in B4.2.
- **Renderer components untested:** `Browser.tsx`/`SplitView`/`main.tsx` follow the repo's established deferral — verified manually in the GUI (B5, C2).
