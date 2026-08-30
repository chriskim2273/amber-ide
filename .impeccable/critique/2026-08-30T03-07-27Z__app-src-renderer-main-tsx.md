---
target: Amber desktop UI/UX
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-30T03-07-27Z
slug: app-src-renderer-main-tsx
---
⚠️ DEGRADED: single-context (no sub-agent or Task tool exposed)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3 | Strong process, memory, activity, and connection signals; some async actions lack progress feedback. |
| 2 | Match System / Real World | 3 | Developer terminology fits, but several glyphs require translation. |
| 3 | User Control and Freedom | 3 | Good confirmations and cancellation; no undo for layout changes or terminal closure. |
| 4 | Consistency and Standards | 3 | Cohesive tokens, but emoji, Unicode glyphs, and text controls form an uneven icon language. |
| 5 | Error Prevention | 3 | Strong kill, overwrite, draft, and conflict guards; dense adjacent actions still invite misclicks. |
| 6 | Recognition Rather Than Recall | 2 | Important pane actions are glyph-only, hover-revealed, or buried in context menus. |
| 7 | Flexibility and Efficiency | 4 | Excellent shortcuts, direct manipulation, CLI parity, search, zoom, and batch cleanup. |
| 8 | Aesthetic and Minimalist Design | 3 | Terminal content dominates, but management chrome is noisier than necessary. |
| 9 | Error Recovery | 3 | Work is preserved well; some error banners do not provide a direct recovery action. |
| 10 | Help and Documentation | 2 | Shortcut help exists, but contextual guidance and first-run explanation are thin. |
| **Total** |  | **29/40** | **Good foundation; targeted UX work would materially improve it.** |

## Design Specificity Verdict

**LLM assessment:** Amber feels deliberately built for terminal work, but not yet unmistakably built around persistence. The dark canvas, violet focus state, dense tab strip, and pane chrome are coherent, yet another developer tool could use them unchanged. Amber’s unique mechanism, continuity owned by a persistent daemon, is nearly invisible while everything is healthy.

**Deterministic scan:** The source scan returned zero findings. The live computed-style detector reported 38 findings, with 39 detail lines due to its own count mismatch. Actionable findings were:

- White text on violet primary controls measures **3.9:1**, below the 4.5:1 requirement for 12px text.
- All visible memory tags use **10.5px** functional text.
- DOM inspection found **20px** pane and toolbar controls and **16px** tab-close targets.

Intentional or false-positive findings included ellipsized pane titles, full-bleed terminal padding, the documented violet accent, terminal-controlled ANSI colors, and the compact type hierarchy.

**Visual overlays:** Injection and runtime scanning succeeded in an isolated headless Electron page. The harness cannot present a persistent `[Human]` browser tab, and the page was closed during required cleanup.

## Overall Impression

Amber is already unusually capable and operationally coherent. Its biggest opportunity is to remove management noise while making its defining promise, preserved continuity, more visible and reassuring.

## What’s Working

1. **Terminal-first composition:** almost every pixel below two shallow chrome rows belongs to active work.
2. **Operational state language:** focus, run state, activity, memory, warnings, and failures are visible without large dashboards.
3. **Power-user depth:** keyboard navigation, drag/drop, split manipulation, CLI parity, search, zoom, and workspace persistence are excellent.

## Priority Issues

### [P1] The top toolbar exposes too many equal-weight decisions

**Why it matters:** Four utility glyphs, a nine-option pane-kind selector, cwd, creation, remote access, and help compete in one row. The most common action is not visually dominant enough.

**Fix:** Let `+ Pane` open the kind picker. Remove the persistent `NEW` selector. Move save, load, sessions, and memory into one labeled workspace menu or command surface. Keep workspace, cwd, `+ Pane`, continuity health, remote status, and one overflow action visible.

**Suggested command:** `/impeccable distill`

### [P1] Pane actions are cryptic and repeated eight times in a dense mosaic

**Why it matters:** `⠿`, `⟳`, `↺pi`, `⬌`, and `⬍` require hover text or prior knowledge. Repeating the cluster in every focused or hovered pane creates noise exactly where users need to read terminal output.

**Fix:** Keep only one or two high-value actions visible, such as move and overflow. Put refresh, reload, split directions, freeze, zoom, and close into a labeled menu while preserving shortcuts and context-menu parity.

**Suggested command:** `/impeccable clarify`

### [P1] Primary contrast and control sizing miss the accessibility floor

**Why it matters:** White on `#7c6cff` is only 3.9:1. Memory values are 10.5px, pane buttons are 20px, and tab closes are 16px. This strains low-vision and motor-impaired users and makes destructive misclicks more likely.

**Fix:** Introduce a darker filled-primary token around `#6f5ff0` or darker while retaining the current violet for focus. Raise functional metadata to at least 11.5px and desktop controls to 24–28px; keep 44px touch targets.

**Suggested command:** `/impeccable audit`

### [P2] The persistence promise is invisible when the system is healthy

**Why it matters:** Amber’s strongest differentiator is communicated in documentation, not in the resting product. Users see memory and remote state, but not whether their work is safely owned and recently snapshotted.

**Fix:** Add one compact, calm continuity affordance showing daemon health, live-session count, and last successful snapshot. Clicking it should open detailed status and recovery information. Avoid a permanent success banner.

**Suggested command:** `/impeccable delight`

### [P2] Iconography lacks one visual grammar

**Why it matters:** Emoji, arrows, a braille grip, punctuation, dots, and text labels have inconsistent optical weight. The interface feels assembled rather than authored.

**Fix:** Adopt one restrained icon family or normalize a small custom set to the same box, stroke, baseline, and state behavior. Keep semantic dots and the amber application mark distinct.

**Suggested command:** `/impeccable polish`

## Persona Red Flags

**Alex, power user:** Shortcuts and direct manipulation are excellent. The repeated pane action cluster wastes visual bandwidth, and common creation requires coordinating the toolbar selector with `+ Pane` rather than invoking one command.

**Jordan, first-timer:** `🧹`, `⚖`, `⠿`, `⬌`, `⬍`, and `↺pi` are not self-explanatory. The nine pane kinds appear before the product explains which one to choose. Jordan will understand “terminal workspace” but may miss why Amber is safer than an ordinary terminal.

**Sam, keyboard and low-vision user:** ARIA labels and focus rings are strong. The blockers are 16–20px targets, 10.5px metadata, low-contrast primary controls, color-led agent identity, and features revealed primarily through hover.

## Minor Observations

- The four-pixel focused-pane halo becomes visually heavy when eight panes are visible.
- Exact memory values compete with titles in narrow panes; show warnings by default and exact values on focus or hover.
- The labeled `remote` status is a strong model for replacing unexplained toolbar glyphs.
- The mobile structure is thoughtful, but a real coarse-pointer device pass remains necessary; Electron CDP touch emulation did not activate the app’s mobile branch.
