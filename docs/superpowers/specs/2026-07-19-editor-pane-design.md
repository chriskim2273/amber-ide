# Editor pane — design

**Date:** 2026-07-19
**Status:** implemented + live-verified 2026-07-19. Deviations: split-mode scroll sync not implemented (§7, security boundary wins); `.amberws` round-trip and the native open/save dialogs are unit-tested only (a native modal cannot be driven headlessly).
**Depends on:** the browser pane (`2026-07-18-browser-pane-design.md`, shipped) —
this is the same class of app-local pane and copies its structure deliberately.

Read `CLAUDE.md` first. This spec obeys it. Like a browser pane, an editor pane
has **no daemon session**: it is owned entirely by the app-local sidecar (spec
§2 of the browser design, accepted tradeoff — sidecar loss loses the pane, same
class as split geometry). No Rust, no daemon, no protocol changes.

## 1. Settled decisions (user, 2026-07-19)

| Question | Decision |
|---|---|
| Surface | **Desktop app only.** New pane kind `editor`. The phone UI stays terminal-only. |
| Engine | **CodeMirror 6** — modular, bundles cleanly, real JSON/Markdown modes. |
| File access | **Native dialogs + recents.** Open/Save anywhere; the pane remembers its path across restarts. |
| Specials | **All four:** JSON validate/format/fold, JSON tree + path copy, Markdown preview + outline, Markdown editing helpers. |

## 2. Pane identity & persistence

- Id grammar `editor-<ws>-<tab>-<ord>-<id>` — `shared/editorName.ts`, mirroring
  `browserName.ts` (`formatEditorName`/`parseEditorName`/`isEditorName`).
- Sidecar gains `editors: Record<paneId, EditorEntry>`:
  ```ts
  interface EditorEntry {
    ws: number; tab: number; ord: number
    path: string | null          // absolute; null = unsaved scratch buffer
    view?: 'code' | 'split' | 'preview'   // markdown view mode (default 'code')
    outline?: boolean            // markdown outline / json tree visible
    wrap?: boolean               // soft wrap (default true for md, false for json)
  }
  ```
  Shape-guarded on parse exactly like `parseBrowsers` (drop malformed entries
  rather than throwing — a hand-edited sidecar must never brick startup).
- `mergeEditors` injects editor panes into `groupSessions` output and feeds their
  ids to `reconcile` as always-live, mirroring `mergeBrowsers`.
- `LayoutFile.recentFiles?: string[]` — most-recent-first, deduped, capped at 20.
- `.amberws` save/load routes editor panes to `LoadPlan.editors` (never
  `creates`), mirroring browsers. A loaded editor pane restores its path; its
  **content is read from disk**, never embedded in the workspace file.

## 3. Unsaved work (this is the correctness-critical part)

An editor holds user work that exists nowhere else. Rules:

1. **Dirty tracking.** The pane header shows a dot when the buffer differs from
   what was last read/written. `Cmd/Ctrl+S` saves.
2. **Draft persistence.** While dirty, the buffer is written (debounced ~800 ms)
   to `<state>/drafts/<paneId>.txt` via the same atomic write the layout sidecar
   uses. On save, the draft file is deleted. On app restart, a pane whose draft
   exists and differs from the file on disk restores the DRAFT and shows a
   "restored unsaved changes" banner with "keep" / "discard" actions. The layout
   sidecar never carries buffer text (it is small, atomic, and rewritten often).
3. **Close guard.** Closing a dirty pane (pane ✕, tab close, workspace replace)
   prompts save / discard / cancel. Cancel aborts the close.
4. **External-change conflict.** Every read records the file's `mtimeMs`; a save
   sends that mtime back. If the file changed underneath, main returns
   `{ conflict: true }` and the pane offers **overwrite** / **reload** /
   **save as** — it never silently clobbers another writer.

## 4. Main-process file IO (`app/src/main/`)

All disk access lives in main; the renderer only ever holds paths and text.

| IPC | Shape | Notes |
|---|---|---|
| `editor-open-dialog` | `() → { path, text, mtimeMs } \| null` | `dialog.showOpenDialog`, filters: all / .json / .md |
| `editor-read` | `(path) → { text, mtimeMs } \| { error }` | for restore-from-sidecar |
| `editor-save` | `(path, text, expectedMtimeMs \| null) → { mtimeMs } \| { conflict: true, mtimeMs } \| { error }` | atomic tmp+rename |
| `editor-save-dialog` | `(suggestedName, text) → { path, mtimeMs } \| null` | Save As |
| `editor-draft-write` / `editor-draft-read` / `editor-draft-clear` | `(paneId, text)` | `<state>/drafts/<paneId>.txt`, atomic |

Guards on every read (a wrong click must not wedge the renderer):
- **Size cap 8 MiB** → `{ error: 'too large' }`.
- **Binary sniff** — a NUL byte in the first 8 KiB → `{ error: 'binary file' }`.
- `stat` must be a regular file (no directories, no devices).
- Path is used verbatim (this is a local IDE with a shell in the next pane —
  there is no sandbox to pretend at), but it must be **absolute** and is
  `realpath`-resolved for the recents list.

## 5. Editor component (`app/src/renderer/Editor.tsx`)

- CodeMirror `EditorView` created imperatively in a ref and **never** re-created
  by React reconciliation (constitution rule #5's discipline, same as xterm):
  React renders chrome; document changes flow through CM transactions. The
  component is memoized like `Pane`.
- Language mode chosen from the extension: `.json`/`.jsonc` → JSON, `.md`/
  `.markdown` → Markdown, everything else → plain text (no highlighting). Mode
  is re-selected via a `StateEffect`-reconfigured compartment on Save As, not by
  remounting.
- Theme mirrors `theme.css` tokens (dark), font size follows the app-wide
  `layout.fontSize` like terminals do.
- Header: file name + dirty dot, path tooltip, Open / Save / Save As, mode-
  specific buttons (§6/§7), and the standard pane affordances (grip, close).
- Chords, scoped to a focused editor pane: `Cmd/Ctrl+S` save, `Cmd/Ctrl+Shift+S`
  save as, `Cmd/Ctrl+O` open, `Cmd/Ctrl+F` CodeMirror search panel. These must
  NOT collide with the existing global `CHORD_TABLE` entries — register them on
  the editor's own DOM subtree, not the window.

## 6. JSON specialization (`shared/jsonTools.ts`, pure + TDD'd)

- **Validate:** parse errors surfaced as CodeMirror lint diagnostics with a real
  line/column (derive from the `position` in the `SyntaxError` message — write a
  helper `jsonErrorAt(text, err)` and unit-test it, including the last-line and
  empty-document cases).
- **Format / minify:** `formatJson(text, indent)` and `minifyJson(text)` — both
  return `{ text }` or `{ error }`, never throw.
- **Sort keys:** `sortJsonKeys(text)` — recursive, stable, arrays untouched.
- **Fold:** CodeMirror's `foldGutter` + `codeFolding`.
- **Tree view + path copy:** `buildJsonTree(value)` → nodes `{ key, path, kind,
  preview, children }` where `path` is JSONPath-ish (`$.a.b[0]`), rendered as a
  collapsible side panel. Clicking a node copies its path (clipboard) and moves
  the cursor to that node's position in the text (`jsonNodeOffset(text, path)`).

## 7. Markdown specialization (`shared/mdTools.ts` + `renderer/MdPreview.tsx`)

- **Preview:** rendered with `marked` into a **sandboxed `<iframe srcdoc>`**
  (`sandbox=""` — no scripts, no same-origin) with a strict CSP
  (`default-src 'none'; img-src data: file:; style-src 'unsafe-inline'`).
  **Rationale (security, not taste):** markdown may contain raw HTML/scripts, and
  this renderer holds the `window.amber` bridge, i.e. file-write IPC. Rendering
  untrusted markdown into the renderer DOM would be an XSS with disk access. The
  iframe is the boundary; do not swap it for `dangerouslySetInnerHTML` plus a
  sanitizer.
  **Verified live (2026-07-19)** in the running app: a `sandbox=""` srcdoc frame
  renders, its inline `<style>` applies (so the dark theme works), and an
  injected `<script>` does NOT execute. Note CSP keywords inside the frame's own
  meta must be quoted (`'none'`, `'unsafe-inline'`) — unquoted silently voids the
  policy and drops the styles.
- **Images.** The renderer's CSP (`img-src 'self' data:`) also governs the
  srcdoc frame, so `file:` images do NOT load — verified live. Local images are
  therefore inlined by the main process as `data:` URIs before the HTML reaches
  the frame: `editor-inline-images(mdDir, html)` resolves relative/absolute local
  paths, caps each image at 2 MiB and 10 images per document, and skips anything
  else. **Remote `http(s)` images are never fetched** — a markdown file must not
  be able to phone home from the editor.
- **View modes:** code / split / preview, persisted per pane (§2).
- **Outline:** `mdOutline(text)` → `{ level, text, line }[]`; a jump list that
  moves the cursor + scrolls. Same panel slot as the JSON tree.
- **Synced scroll** in split mode: **NOT implemented — accepted deviation
  (2026-07-19).** `sandbox=""` makes the preview frame cross-origin, so its
  scroll position can be neither read nor set; the only way to sync it is
  `allow-same-origin`, which would dissolve the security boundary above. The
  boundary wins: the preview scrolls independently.
- **Editing helpers** (all pure, all TDD'd): `toggleBold`, `toggleItalic`,
  `toggleInlineCode`, `wrapLink(sel, url)`, `toggleList('-'|'1.')`,
  `toggleTaskCheckbox`, `formatTable(text)` (align pipes across a GFM table).
  Each takes `(text, selectionFrom, selectionTo)` and returns
  `{ text, from, to }` so the caller can restore a sensible selection.

## 8. Wiring — the completeness checklist

An editor pane is the SAME class as a browser pane: sidecar-owned, no daemon
session. Every site that special-cases `browser` must handle `editor` too.
TypeScript will NOT catch the misses — the sites are runtime `isBrowserName(…)`
/ `kind === 'browser'` checks, and falling through sends an app-local pane down
the daemon path. Start from:

```sh
rg "isBrowserName|'browser'|newBrowser" app/src/renderer app/src/shared
```

Each of these is a user-visible bug if missed:

| Site | Miss symptom |
|---|---|
| `onSplit` (SplitView → App) | `createSession('amber-…', cwd, 'editor')` → daemon Error banner. Splitting is the main way to make an editor pane. |
| `newPane` / `+ Pane` / `+ ws` | same — a daemon session with an invalid kind |
| `closePane` | `killSession('editor-…')` no-ops AND the sidecar entry leaks → the pane will not close |
| `applyLoad` (replace mode) | same leak; old editor panes survive a workspace replace |
| `moveTo` (cross-tab/ws drag) | `retargetPane` returns null → drag silently does nothing; needs the browser-style sidecar edit, and **must keep the paneId stable** so the §3.2 draft (keyed by paneId) follows the pane |
| `doSave` (.amberws) | `dumpBacklog('editor-…')` → straggler/error banner. Switch the filter to an allowlist (`kind === 'shell' \|\| kind === 'claude'`). |
| `commitLoad` `liveForFix` | editor leaves pruned on the load-timeout path; needs `\|\| isEditorName(n)` |

## 8b. Wiring

- `SplitView` renders `<Editor>` for `meta.kind === 'editor'`, hiding
  terminal-only affordances (refresh, search-in-scrollback, claude reload,
  freeze — a frozen editor is meaningless).
- The split kind picker (shipped 2026-07-19) gains a fourth entry, `editor`; the
  toolbar `new` select gains it too.
- `deriveTab` labels an editor pane `<file name> · editor` (falling back to
  `untitled · editor`), so tab dots/titles work unchanged.
- Pane close routes through the §3.3 dirty guard before the existing
  browser-style sidecar purge.

## 9. Testing

- **Pure/TDD:** `editorName`, `layoutFile` (editors + recentFiles parse/serialize,
  malformed-entry drops), `workspaceFile` (editors in save + LoadPlan), `store`
  `mergeEditors`, all of `jsonTools`, all of `mdTools`.
- **Main process:** atomic save, conflict detection via mtime, size cap, binary
  sniff, draft write/read/clear. Tested against a temp dir.
- **Renderer components** (`Editor`, `MdPreview`, `JsonTree`) stay test-deferred
  per the repo pattern, and are covered by the live-GUI pass instead.
- **Live GUI** (isolated private daemon + private user-data-dir): open a JSON
  file → break it → see the lint error → format → tree path copy; open a .md →
  split preview → outline jump → bold/list/checkbox helpers → save; dirty dot →
  restart app → draft restored; external edit → conflict prompt.

## 10. Out of scope

Multiple files per pane (one pane = one file), LSP/IntelliSense, git integration
or diffs, project-wide find/replace, remote files, languages beyond JSON/MD
(everything else opens as plain text), image/binary editing, and any daemon or
protocol change.
