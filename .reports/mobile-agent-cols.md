# How narrow can an agent TUI go? (spec §2.5)

The mobile-web spec deliberately left the phone default font size unset:
"What a real claude/codex/grok TUI needs is **not settled by this spec** —
Phase B's first task is to measure." This is that measurement.

## Method

`/tmp/colmeasure/render.py`: fork a real pty, set its winsize to the candidate
width, launch the real agent binary in a scratch cwd, capture ~6 s of output,
then replay it through **pyte** (a VT emulator) and inspect the rendered screen.

The emulator matters. A first pass counted newlines in the raw stream and
reported codex and grok as one enormous overflowing line — both paint with
absolute cursor positioning, so newline-counting measures nothing about them.
Only a real emulator shows the screen a phone user would actually see.

Honest limits: this renders the **first screen** (banner, trust prompt, input
box, status line) with no prompt sent. That is what a phone user stares at, but
it is not a full-session judgement — long assistant output, diffs and tool
panes are not covered.

## Result — every agent reflows correctly at 40 columns

| agent | 40 cols | 46 cols | 54 cols | 80 cols |
|---|---|---|---|---|
| claude | reflows, frame spans full width | reflows | reflows | reflows |
| codex | reflows, no truncation | reflows | reflows | reflows |
| grok | reflows; footer label truncates cleanly | reflows | reflows | reflows |

No agent clipped text, overflowed its frame, or wrapped mid-frame at any tested
width. claude's rule and box track the width exactly (`widest == cols` at every
size). grok's status footer shortens rather than overflowing
(`always-approv─╯` at 40).

Prose gets narrow at 40 — claude's safety paragraph runs 8 lines instead of 3 —
but it is correct and readable, not damaged.

## Chosen default: 14px on a phone

At 390 CSS px (iPhone 13/14 logical width) an xterm cell is ≈0.6em wide:

| font size | columns at 390px |
|---|---|
| 12px | ~54 |
| 13px (desktop default) | ~50 |
| **14px** | **~46** |
| 16px | ~40 |

14px lands on ~46 columns: comfortably above the 40 floor this measurement
established, while giving noticeably bigger glyphs than the desktop's 13px —
which is the right trade on a device held at arm's length.

Applied as a **fallback only**: an explicit `fontSize` in the layout sidecar
still wins, so pinch-to-resize on the phone and the desktop's font chords both
keep working and keep persisting. A user who has never set one gets 14px on a
phone and 13px on the desktop.

## Live check on a 390×844 phone viewport

Chrome DevTools emulation (`390x844x3,mobile,touch`) against a private daemon +
private `amber web`, 14px default:

- terminal configured at **14px** (`.xterm-char-measure-element` reports it);
- a zoomed pane reflowed its pty to **44×41** — above the 40-column floor this
  report established, and the agent-visible grid a phone actually gets.
