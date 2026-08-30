# Coordinated UI/UX Pass — Design

**Status:** implemented and verified  
**Date:** 2026-08-30

## Problem

Amber’s terminal-first foundation is strong, but its resting interface makes routine actions harder to recognize than they need to be. The top toolbar presents too many equal-weight choices, every pane repeats a dense cluster of cryptic glyphs, several interactive targets and labels fall below the agreed accessibility floor, and Amber’s defining continuity promise is nearly invisible while the daemon is healthy.

## Goals

1. Make the primary creation path obvious without adding chrome.
2. Reduce pane-header noise while preserving every existing action and shortcut.
3. Meet the agreed contrast, functional-text, pointer-target, focus, and mobile touch floors.
4. Expose daemon continuity calmly and truthfully.
5. Normalize the high-frequency application iconography into one authored SVG grammar.

## Non-goals

- No daemon architecture or session-authority changes.
- No new persistence guarantees or fabricated “last saved” timestamps.
- No changes to terminal rendering, PTY geometry, session naming, or one-way daemon flow.
- No visual redesign away from the incumbent Preservation Console identity.
- No removal of keyboard shortcuts or context-menu actions.

## Product and design constraints

- The terminal remains the dominant surface.
- Desktop chrome stays compact; coarse-pointer mobile controls remain at least 44px.
- Preservation Violet remains the focus/selection color. A darker violet is introduced only for filled controls where white text needs stronger contrast.
- Operational dots remain semantic status markers; they are not replaced with decorative icons.
- Session and persistence claims must come from daemon connection/session truth or from a confirmed `SnapshotOk` response.

## Interaction architecture

### Desktop toolbar

The toolbar is reduced to four coherent groups:

1. Workspace navigation: workspace pills and `+ ws`.
2. Creation context: current working directory and one primary `+ Pane` button.
3. Continuity: a compact daemon/session status control.
4. Utilities: remote access, a single workspace-tools overflow, and shortcut help.

`+ Pane` owns the pane-kind picker. Selecting a kind creates immediately and remembers that kind for existing keyboard/new-tab/new-workspace paths, preserving current behavior while removing the persistent nine-option selector.

The workspace-tools menu consolidates Save workspace, Load workspace, Sessions, and Memory. These actions remain labeled and keyboard-focusable.

### Pane headers

Each pane shows only:

- semantic kind/run-state dot;
- title and compact status badges;
- a drag handle;
- one overflow action.

The overflow menu carries labeled rows for terminal refresh, provider-specific reload, split right/down, zoom/restore, freeze/unfreeze, copy cwd, and close. Browser/editor capability differences remain respected. Existing context-click access opens the same menu, so there is one action model rather than two divergent surfaces.

### Continuity status

A compact status pill shows connection health and the number of live daemon sessions. Its detail popover states:

- whether the daemon is connected;
- live and exited-but-retained session counts;
- that daemon-owned sessions continue independently of the window;
- snapshot state.

Before any manual snapshot, the UI says automatic snapshots are daemon-managed; it does not invent a timestamp. “Saved just now” appears only after receiving `SnapshotOk`. A manual “Snapshot now” action reports pending, confirmed, or failed/disconnected state.

### Icon system

A small local SVG icon component provides one 16px, round-cap, 1.75px-stroke grammar for high-frequency app controls. It replaces emoji and ambiguous Unicode in the toolbar, pane actions, menu affordances, close buttons, and frozen-state controls. Text remains beside icons where recognition matters; icons do not replace action labels in menus.

## Accessibility requirements

- Filled violet controls use a darker token with white contrast above 4.5:1.
- Focus violet remains unchanged and visible via a shared 2px ring.
- Desktop icon controls and tab-close targets are 26px minimum.
- Functional metadata is at least 11.5px.
- Mobile/coarse-pointer targets stay at least 44px, menu rows at least 48px.
- Menus use native buttons with menu/menuitem semantics and meaningful accessible names.
- Status updates use restrained `role=status`/`aria-live`; no permanent success banner.
- `prefers-reduced-motion` disables non-essential pulse/transition behavior.

## State and data flow

- Existing `connected` renderer state and daemon-owned `state.sessions` provide health/count truth.
- A new renderer bridge method sends the already-supported `Snapshot` control message.
- The utility process maps `snapshot` to `ControlMsg::Snapshot`; the existing daemon returns `SnapshotOk`.
- Renderer-local snapshot UI state is presentation only and resets to an honest disconnected/error state if the socket drops.
- No daemon protocol variant or Rust change is required.

## Failure behavior

- Snapshot while disconnected is not sent and is presented as unavailable.
- If the daemon disconnects while a snapshot is pending, the status becomes failed/disconnected rather than successful.
- Daemon errors continue through the existing error banner; the continuity popover never masks them.
- Menu dismissal supports Escape and outside pointer interaction.

## Acceptance criteria

- One visible desktop pane-creation button opens a labeled kind picker; the persistent kind select is gone.
- Save/load/sessions/memory are available from one labeled overflow menu.
- Every pane header shows move and overflow only; every removed action remains available in the labeled pane menu or by shortcut.
- The resting toolbar exposes daemon health and live-session count.
- Snapshot success text appears only after `SnapshotOk`.
- White text on filled violet passes 4.5:1; functional metadata and controls meet agreed floors.
- High-frequency toolbar and pane controls use the normalized SVG icon grammar.
- Existing desktop behavior, keyboard shortcuts, mobile 44px targets, and terminal geometry remain intact.

## Design review

The design was reviewed against `PRODUCT.md`, `DESIGN.md`, the 29/40 critique, the architecture constitution, and the Impeccable audit/distill/clarify/delight/polish guidance.

### Review findings resolved

- **Truthfulness:** removed the proposed unverified “last automatic snapshot” timestamp; only confirmed manual snapshots get relative success copy.
- **Authority:** retained daemon session truth and existing one-way create/kill/reconcile behavior.
- **Discoverability:** menus use labeled rows; the only glyph-only controls have explicit labels and familiar move/more roles.
- **Efficiency:** shortcuts remain unchanged and the remembered kind preserves quick repeated creation.
- **Mobile:** existing adaptive replacement remains; touch floors are not traded for desktop density.
- **Scope:** no Rust protocol extension is needed because `Snapshot`/`SnapshotOk` already exist.

### Residual risk

Renderer components are only lightly unit-testable in the current repository. Pure view-state logic and protocol routing will be unit-tested, while menu positioning, touch sizing, visual density, and focus behavior require the bounded live Electron inspection.
