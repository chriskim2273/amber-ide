---
target: desktop app connected to Amber Pocket
total_score: 32
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-08-30T07-26-18Z
slug: app-src-renderer-main-tsx
---
## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Current-pane state is excellent; cross-workspace attention is not surfaced. |
| 2 | Match system / real world | 4 | Language matches experienced terminal users. |
| 3 | User control and freedom | 3 | Strong close, freeze, zoom, and cancel paths; global session navigation is weak. |
| 4 | Consistency and standards | 3 | Pocket and desktop duplicate kind/action labels and can drift. |
| 5 | Error prevention | 3 | Destructive paths are guarded and daemon confirmation remains authoritative. |
| 6 | Recognition rather than recall | 2 | Sessions and zoom exist, but key global actions are buried in menus or gestures. |
| 7 | Flexibility and efficiency | 4 | Excellent keyboard, drag, menu, CLI, and multi-client paths. |
| 8 | Aesthetic and minimalist design | 4 | Terminal content dominates; chrome is disciplined and product-specific. |
| 9 | Error recovery | 3 | Exit, disconnect, memory, and recovery states are clear and actionable. |
| 10 | Help and documentation | 3 | Shortcut help and tooltips are present; contextual discovery remains limited. |
| **Total** | | **32/40** | **Good** |

## Design Specificity Verdict

Amber feels authored for persistent terminal work, not interchangeable with a generic dashboard. The carbon console, tiny operational state markers, live pane geometry, frozen overlays, and concentrated violet focus treatment all reinforce preservation and continuity.

The source detector returned zero findings for `main.tsx`. The live detector reported 78 overlays, but inspection traced them to xterm-owned terminal text, cursor, ANSI colors, intentional ellipsis, and pane overflow containment. They are false positives for the app chrome rather than actionable design defects.

## Overall Impression

The desktop is already visually strong. It should not inherit Pocket's command-center-first layout. The biggest opportunity is behavioral continuity: expose Pocket's cross-workspace attention intelligence as a compact desktop instrument without reducing terminal area.

## What's Working

- Terminal dominance is excellent. Eight panes remain the composition, while chrome stays peripheral.
- Operational state is legible. Focus, freeze, memory, activity, continuity, and remote access each have restrained semantic treatments.
- Progressive disclosure is disciplined. Creation, workspace tools, and pane actions remain available without permanently crowding the canvas.

## Priority Issues

### P1: No desktop cross-workspace attention surface

**Why it matters:** The desktop shows current workspace and tab state well, but a user returning after an interruption cannot answer "what needs me across all workspaces?" without scanning tabs and opening maintenance UI.

**Fix:** Add a conditional `Needs you` affordance near continuity, visible only when the shared command-center model has attention items. Open a compact popover grouped by Needs you, Working, and Parked; clicking a row should switch workspace/tab and focus the existing pane. End with `View all sessions`, not a second desktop landing page.

**Suggested command:** `/impeccable shape`

### P1: Pocket and desktop action semantics can drift

**Why it matters:** Desktop says pane, freeze, and unfreeze; Pocket says session, parked, freeze, and resume. Creation kinds and action eligibility are separately declared. Users should not have to learn client-specific names for the same daemon state.

**Fix:** Extract shared presentation metadata and capability rules. Keep form factors different, but standardize state labels (`Frozen by you`, `Parked for memory`, `Exited to shell`), action verbs, danger copy, kind order, and descriptions.

**Suggested command:** `/impeccable clarify`

### P2: The Sessions dialog is maintenance-only

**Why it matters:** It can inspect, adopt, and kill, but cannot navigate to an existing pane. Pocket teaches that a session row is an entry point. On desktop, the same row becomes a dead end unless it is orphaned.

**Fix:** Add `Show` for in-pane sessions. It should switch workspace/tab, focus the pane, and close the dialog. Add an Attention filter powered by the same selector, while preserving the full daemon cleanup list.

**Suggested command:** `/impeccable harden`

### P2: Machine identity is asymmetric

**Why it matters:** Pocket leads with machine identity and remote desktop windows show a remote marker, but the local desktop window has no equally clear identity. Multiple local/SSH Amber windows are harder to distinguish at the OS switcher level.

**Fix:** Put machine identity in the window title (`Amber · teapot-dev`) and in the continuity popover. Keep it out of the permanent toolbar unless the window is remote.

**Suggested command:** `/impeccable clarify`

### P3: Pane headers can accumulate competing metadata

**Why it matters:** Title, memory, frozen, zoomed, drag, and menu affordances share 28 px. Narrow splits already ellipsize long titles, so concurrent state badges can erase useful identity.

**Fix:** Apply the command-center precedence to a single primary state badge. Keep memory as secondary telemetry only when warning/growing or when the pane is wide enough.

**Suggested command:** `/impeccable distill`

## Persona Red Flags

**Alex, power user:** Excellent shortcuts and drag paths, but no one-step way to jump to attention in another workspace. The current Sessions dialog cannot navigate to an existing pane.

**Sam, keyboard and low-vision user:** Keyboard focus is explicit and menus are labeled. The new attention surface must support arrow navigation, Enter to reveal, Escape to dismiss, and text labels in addition to semantic color.

**Returning developer:** After hours away, `12 live` confirms persistence but does not communicate priority. The user still has to reconstruct where work stopped.

## Minor Observations

- Do not move Sessions or Pocket navigation into a permanent desktop sidebar.
- Do not add another always-visible colored status dot. The attention affordance should disappear at zero.
- Keep seen/activity state client-local for now; syncing it through the daemon would change semantics and needs a separate product decision.
- The compact 11 to 13 px hierarchy is intentional for this operating surface, despite the detector's flat-type warning.

## Questions to Consider

- Should desktop attention be a small popover, or an Attention tab inside the existing Sessions dialog?
- Should clicking an attention row only focus the pane, or also zoom it?
- Should manual `Frozen` and guardian `Parked` remain separate visible states everywhere?
