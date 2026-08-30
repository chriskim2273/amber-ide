# Amber Pocket mobile product design

**Date:** 2026-08-29

**Status:** visual prototype complete; production command-center model, mobile shell, focus chrome, sheets, and keyboard hardening implemented; physical-device hardening remains

**Prototype:** `docs/prototypes/amber-pocket/index.html`

**Builds on:** `2026-08-22-mobile-web-experience-design.md`, `2026-08-01-amber-ide-as-a-webapp-design.md`

## 0. Product decision

Amber Pocket is a mobile operating surface for the existing Amber system. It is
not a new terminal client, a second source of workspace truth, or a miniature
copy of the desktop toolbar.

The browser remains a disposable client:

```text
Amber Pocket PWA
      | HTTPS + WSS over Tailscale
      v
   amber web
      | Unix socket
      v
 amber daemon
      |
 persistent PTYs and supervised agents
```

The mobile product has two primary modes:

1. **Command center:** scan sessions, find work that needs attention, and move
   among machines, workspaces, and tabs.
2. **Focus terminal:** give one live terminal almost the whole viewport and
   expose only the controls needed to operate it from touch.

The existing split mosaic remains available as an overview and manipulation
mode. It is not the default landing screen on a phone.

## 1. Design read

Reading this as an adaptive developer tool for individual developers who keep
several long-running agents and shells alive. The interface must feel native,
precise, low-light, and trustworthy. Mode is **redesign-preserve**: mobile
composition changes substantially while Amber's visual identity, daemon
architecture, session semantics, and terminal fidelity remain intact.

**Impeccable mode:** Operate. The interface should disappear into the task.

**Design-master preset:** Editorial minimal, used only for its workspace-tier
restraint and flat tonal hierarchy. The reference lock overrides its warm light
canvas and low density. Amber remains dark, compact, and operational.

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 7`

Motion communicates feedback, continuity between command center and terminal,
and sheet state. It never decorates terminal output.

## 2. Existing-state audit

### 2.1 Stack

- React renderer shared by Electron and the browser build.
- Vanilla CSS token layer in `app/src/renderer/theme.css`.
- xterm.js owns terminal rendering outside React reconciliation.
- Capability-based mobile mode from `useMobile()`.
- No host checks are allowed under `app/src/renderer/`.

### 2.2 Existing strengths to preserve

- The real renderer is already served at `/app`.
- Grid borrowing makes agent TUIs readable on a phone and restores the prior
  desktop grid when focus ends.
- Mobile key bar includes Esc, Tab, Shift-Tab, sticky Ctrl, arrows, Enter,
  slash, and Ctrl-C.
- Touch scroll behavior distinguishes normal and alternate screens.
- Workspace and tab navigation already collapses into a drawer.
- Context menus already become bottom sheets.
- PWA manifest, safe-area metadata, and desktop QR pairing already exist.
- Existing state colors distinguish agents, activity, suspension, pressure,
  failure, and focus.

### 2.3 Problems this design addresses

1. The phone opens into a split tree whose primary purpose is desktop spatial
   continuity, not mobile triage.
2. Navigation exposes workspace and tab structure but not a fast answer to
   “which session needs me now?”
3. Mobile chrome is functionally adapted but still visually reads as enlarged
   desktop controls.
4. The key bar is complete but has no hierarchy between high-frequency and
   occasional terminal actions.
5. There is no mobile-first machine identity or connection context at the top
   of the experience.
6. Existing real-device gaps remain: soft keyboard, long press, momentum,
   clipboard, safe areas, and installed-PWA behavior have not been proven on
   physical iOS and Android devices.

### 2.4 Current dial reading

- Variance: 3
- Motion: 1
- Density: 8

Amber Pocket raises compositional variance and state-transition quality while
slightly reducing the amount of simultaneous chrome.

## 3. Research summary

Research used the existing Amber implementation as the primary source of truth,
then compared established mobile terminal and developer-tool patterns.

### Sources reviewed

- Amber desktop renderer, mobile CSS, `Drawer`, `KeyBar`, `Pane`, and the live
  mobile verification report.
- Apple Human Interface Guidelines for tab bars, sheets, safe areas, and
  accessible controls.
- Material 3 bottom-sheet behavior as a cross-platform reference for reachable
  contextual actions.
- Blink Shell: terminal-first focus and minimal persistent chrome.
- Prompt 3: terminal-first navigation and an explicit mobile key surface.
- Termius: session/host command center, adaptive extra keyboard, and clear
  connection context.
- Working Copy: native-feeling hierarchy, compact task navigation, and
  progressive disclosure in a dense developer tool.

### Product patterns extracted

- A mobile terminal should devote almost the whole focused screen to terminal
  content.
- Session discovery and terminal operation are different jobs and should have
  different compositions.
- The extra-key surface must stay reachable above the software keyboard and
  must not blur the terminal.
- Contextual actions belong in a bottom sheet, not in a row of tiny header
  icons.
- Machine identity and connectivity should be visible before the user enters a
  session.
- Top-level destinations can use a bottom navigation bar, but workspace and tab
  hierarchy should remain inside the command center rather than become more
  permanent tabs.

## 4. Reference lock

**Primary reference/direction:** Amber's existing “Preservation Console” design
system, recomposed through native mobile navigation and sheet patterns.

**Preserve:**

- Obsidian canvas and Carbon surface hierarchy.
- Preservation Violet for primary action, selection, and keyboard focus.
- Warning Amber only for the brand mark and real warning/agent semantics.
- System sans for human controls and monospace for machine truth.
- Fine structural borders, compact density, and terminal dominance.
- Existing agent and run-state colors as semantic markers only.

**Borrow only:**

- Termius-style session command center and adaptive terminal key hierarchy.
- Blink/Prompt terminal-first focus composition.
- Native platform bottom sheets, safe areas, and predictable back behavior.

**Role rules:**

- Violet never becomes a decorative wash.
- Amber never replaces Violet as the general interaction accent.
- Agent colors appear in identity marks and state, not in large surfaces.
- Shadows mean a surface is floating or moving.
- Rounded pills are limited to compact state and segmented filters.

**Media strategy:** code-native product UI only. No decorative bitmap media is
needed. The actual xterm surface is the visual evidence.

**Reject:**

- A shrunken desktop toolbar.
- A card-heavy dashboard that makes the terminal feel secondary.
- Gamer-terminal neon, ornamental glow, gradients, and glass everywhere.
- Permanent rows of tiny pane actions.
- A second client state model or mobile-only session authority.

## 5. Decision ledger

| Decision | Source | Rule or role | Why |
|---|---|---|---|
| Command center is the phone landing screen | Termius, Amber mobile task | Session discovery | A phone is used to find work before operating it |
| Focus mode is edge-to-edge terminal | Blink, Prompt, Amber core rule 5 | Terminal dominance | Preserves readable grid area and lowers cognitive load |
| Violet remains the primary accent | Amber `DESIGN.md` | Selection and focus | Makes mobile feel like Amber rather than a companion rebrand |
| Bottom sheets own contextual actions | Apple HIG, Material 3, existing Amber sheet behavior | Reachable disclosure | Removes tiny action icons without hiding capability |
| Key bar has primary and overflow groups | Prompt, Termius, existing `KeyBar` | Input hierarchy | Keeps critical TUI keys visible while allowing customization |
| Machine context appears in the header | Termius, Tailscale remote model | Connection trust | Prevents accidental work on the wrong computer |
| Session state is text plus color | Accessibility floor, Amber state model | Redundant semantics | Status cannot depend on a colored dot alone |
| Mosaic is a destination, not the landing page | Existing Amber layout | Spatial overview | Keeps cross-client geometry visible without forcing it into triage |

## 6. Information architecture

```text
Command center
  Machine switcher
  Workspace filter
  Attention queue
  Active sessions
  Suspended and exited sessions
  Bottom navigation
    Sessions
    Mosaic
    New

Focus terminal
  Back to command center or mosaic
  Machine and session identity
  Terminal viewport
  Agent/run-state strip when needed
  Adaptive key bar
  Context sheet

Mosaic
  Existing split tree
  Tap pane to focus
  Long press for context sheet
  Back to command center

New session sheet
  Kind
  Working directory
  Workspace and tab destination
  Create
```

The command center groups by urgency, not by daemon implementation detail:

1. **Needs you:** agent waiting, exited session, retrying agent, critical memory
   pressure, or connection failure.
2. **Working:** active supervised agents and foreground shells with recent
   activity.
3. **Parked:** manually or memory suspended agents.
4. **Quiet:** live sessions without recent activity.

Workspace and tab labels remain visible as metadata and filters. Grouping by
urgency never changes the authoritative workspace structure.

## 7. Screen contracts

### 7.1 Command center

**First viewport:** machine identity at the top, a compact workspace selector,
then “Needs you” followed by “Working.” The first session row begins above the
fold. A three-item bottom navigation remains reachable above the safe area.

Each session row contains:

- agent or shell identity marker,
- user-facing title,
- concise run state in text,
- workspace and tab,
- last activity,
- memory only when useful,
- one clear open affordance.

A row tap opens focus mode. A trailing action opens the session sheet. Swipe is
not required for any destructive action.

### 7.2 Focus terminal

**First viewport:** a 48px safe-area-aware header, terminal filling all remaining
space, then the key bar above the software keyboard or home indicator.

Header:

- back button,
- session title,
- kind and run state,
- one context action.

The header collapses to a compact identity strip after terminal input begins and
returns on an upward edge gesture or terminal blur. This animation changes only
transform and opacity. It never changes PTY geometry.

The focused terminal reuses the existing grid-borrow rules:

- agent plus mobile plus focused means borrowed reflow by default,
- shell follows desktop geometry by default,
- explicit overrides remain sidecar-owned,
- leaving focus, page hiding, or socket loss releases the borrow.

### 7.3 Adaptive key bar

Always-visible group:

- Esc
- Tab
- Shift-Tab
- sticky Ctrl
- four arrows
- Enter
- slash
- Ctrl-C

User-configurable quick commands can appear in a second horizontally scrolling
row. They send ordinary terminal input and cannot call privileged daemon
messages. Examples must be labeled as keystrokes or text macros, never as
semantic agent controls.

The bar:

- never blurs xterm's hidden textarea,
- uses 44px minimum targets,
- announces sticky modifier state,
- follows application cursor-key mode,
- keeps interrupt and Enter ahead of the horizontally scrollable arrow cluster,
- stays above `visualViewport` without re-fitting the PTY when the keyboard
  opens.

Keyboard movement is visual-only. `KeyboardDock` translates the key bar by the
covered bottom inset. `Pane` translates the already-rendered xterm host only far
enough to put the active cursor above both the keyboard and key bar. Neither
path changes width, height, padding, or margin. This is load-bearing because the
pane's `ResizeObserver` watches the xterm host: the former `paddingBottom`
approach changed its content box and could make keyboard close look like a real
pane resize, causing FitAddon to reflow the shared PTY. Both the dock and pane
listen to `visualViewport.resize` and `.scroll`, and the bottom inset includes
`visualViewport.offsetTop` so moving browser chrome is not misclassified.

### 7.4 Mosaic

The current real split tree is preserved. Mobile presentation adds:

- a clear command-center return,
- a current workspace/tab title,
- a focused-pane count and connection state,
- the existing tap-to-zoom behavior,
- no automatic PTY resize while a pane is only a tile.

### 7.5 Session action sheet

Actions are ordered by frequency and risk:

1. Open or return to terminal
2. Freeze or resume
3. Move
4. Rename
5. Split
6. Copy working directory
7. Close session

Close remains separated and red. It requires confirmation when the session is
alive. Exited sessions can use “Remove” with explicit copy.

### 7.6 New session sheet

The sheet defaults to the current workspace and tab. It shows only daemon-backed
kinds supported by the mobile web surface. Browser and editor panes remain
explicitly unavailable until their web security models exist.

The primary action says `Create <kind>` instead of `Continue`.

## 8. Visual system extension

This is a surface extension, not a new `DESIGN.md`.

### 8.1 Color

Use existing tokens. Pocket-specific aliases may map to them but may not invent
new brand roles.

```css
--pocket-canvas: var(--bg);
--pocket-surface: var(--surface);
--pocket-raised: var(--surface-2);
--pocket-border: var(--border);
--pocket-focus: var(--accent);
--pocket-action: #6751df; /* darker Violet for AA small button text */
--pocket-brand: var(--warn);
```

The amber icon mark can appear once in machine identity or onboarding. It does
not turn every button orange.

### 8.2 Typography

- 17px semibold screen title.
- 15px medium session title.
- 13px body and metadata, with positive tracking on the smallest text.
- Existing terminal font size remains independently controlled by measured TUI
  readability.
- All paths, memory values, slots, key names, and machine values use monospace.

### 8.3 Shape and elevation

- 8px standard mobile controls.
- 12px elevated session rows and inline groups.
- 16px top corners for bottom sheets.
- Full pills only for compact state filters.
- Resting surfaces use tone plus border.
- Sheets use the existing upward floating shadow.

### 8.4 Motion

- Button press: 90ms scale to 0.98.
- Filter and selection: 120ms color transition.
- Command center to focus continuity: 200ms transform plus opacity.
- Bottom sheet: 240ms transform plus overlay opacity.
- Reduced motion removes translation and scale, retaining a short opacity
  change.
- Terminal output, status dots, and layout geometry never receive decorative
  animation.

## 9. Copy system

Use direct operational language:

- `Needs you`, not `Attention center`.
- `Working`, not `In progress`.
- `Waiting for input`, not `Agent blocked` unless the daemon reports a block.
- `Suspended to free memory`, not `Sleeping`.
- `Connection lost. Reconnecting…`, with a live region.
- `Remove exited session`, not `Delete`.
- `Create Pi session`, not `Continue`.

Never claim an agent is complete unless Amber has a trustworthy state for it.
Activity is output, not completion.

## 10. Accessibility and platform behavior

- 44px minimum touch targets.
- WCAG AA contrast for text and control boundaries.
- Every status has text or an accessible label in addition to color.
- Visible `:focus-visible` treatment remains Violet.
- Browser pinch zoom remains enabled.
- The document uses `100dvh`, safe-area insets, and no body scrolling.
- Sheets contain overscroll and restore focus to their trigger.
- Dialogs and sheets use semantic labels and modal state.
- Destructive actions require clear confirmation.
- Soft-keyboard opening never changes PTY rows; only the key bar and rendered
  terminal pixels translate.
- Platform back first closes a sheet, then exits focus mode, then follows normal
  browser history.
- Landscape prioritizes terminal focus; the command center uses two columns only
  when both remain at least 280px wide.

## 11. Architecture guardrails

1. No mobile component imports `app/src/web/` or checks for Electron.
2. Capability detection remains pointer and viewport based.
3. The daemon remains the source of session truth.
4. The command center derives its groups from daemon events and existing
   sidecar display metadata. It never creates an optimistic session row.
5. Terminal bytes continue through MessagePort directly to xterm.
6. React never updates once per output chunk.
7. Mobile quick commands emit ordinary terminal input only.
8. Browser control messages stay inside the existing server-side whitelist.
9. Browser/editor panes stay hidden or explicitly unavailable until separately
   designed.
10. Grid borrowing and restoration remain server-bookkept.

## 12. Production implementation order

### Slice 1: command-center model — implemented 2026-08-30

- `commandCenterModel` derives urgency groups from `PaneModel`, unseen activity,
  run-state, frozen state, exit state, memory telemetry, and resource pressure.
- Deterministic precedence and ordering are unit-tested. Global pressure remains
  a global alert instead of blaming an arbitrary session.
- Browser and editor panes are explicitly filtered without changing sidecar or
  daemon truth.
- The renderer landed only after the selector tests were green.

### Slice 2: mobile navigation shell — implemented 2026-08-30

- Command center and bottom navigation mount only when `useMobile()` is true;
  desktop composition remains unchanged.
- The phone now lands in Sessions, while Mosaic keeps the existing split tree.
  Workspace filters change display scope without mutating daemon grouping.
- Session and new-session bottom sheets use tagged history entries. Platform
  back dismisses a sheet before it leaves Focus.

### Slice 3: focus terminal chrome — baseline implemented 2026-08-30

- A command-center row opens the existing per-tab zoom state; no second pane or
  terminal transport exists.
- Focus replaces the desktop pane header with machine/session/run-state chrome,
  returns the recovered 26 px to xterm, and exposes the session sheet.
- `Pane`, MessagePort transport, grid borrowing, and terminal lifecycle remain
  unchanged. Header collapse after input is still deferred until real-device
  keyboard timing is measured; the current fixed header never changes PTY
  geometry.

### Slice 4: key-bar hierarchy and quick commands

- Preserve all existing keys and byte-generation tests.
- Add overflow/customization as ordinary input macros.
- Persist customization as app-owned display settings.

### Slice 5: real-device hardening

Verify on at least:

- current iPhone Safari, installed and browser modes,
- current Android Chrome, installed and browser modes,
- portrait and landscape,
- agent alternate screen and normal shell screen,
- software keyboard open and closed,
- reconnect while focused,
- page hide while holding a borrow.

### Slice 6: optional native shell

Only after the PWA passes real-device testing. A native wrapper may add QR
scanning, Keychain/Keystore token storage, biometrics, haptics, and native
sharing. It must continue loading the same renderer and must not become a new
terminal implementation.

## 13. Acceptance criteria

- Phone launches into command center, not an unreadable mosaic.
- A user can identify machine, workspace, session, kind, and run state without
  opening a pane.
- “Needs you” contains only states supported by real data.
- Opening an agent produces a readable borrowed grid.
- Leaving focus restores the prior desktop-sized grid when no newer writer won.
- Opening or closing the software keyboard does not change PTY rows.
- The key bar sits immediately above the keyboard, and the active cursor remains
  visible above the key bar.
- All required TUI keys remain available with 44px targets; interrupt and Enter
  are visible before the arrow cluster.
- Every sheet and navigation transition works with platform back.
- No production renderer code branches on host.
- Desktop layout and interaction remain unchanged.
- Real-device evidence exists before the design is called shipped.

## 14. Explicit cuts

- No React Native terminal rewrite.
- No mobile-owned session database.
- No direct daemon network listener.
- No semantic agent approval UI derived by scraping TUI output.
- No background push notifications in the first production slice.
- No editor or browser pane support in mobile focus mode.
- No visual rebrand of the desktop app.
