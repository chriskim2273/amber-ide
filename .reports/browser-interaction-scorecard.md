# Browser interaction scorecard

20 consecutive Xvfb/Electron 43 matrix runs. Adapter request counts are from a separate passing instrumentation run; timings include fixture setup inside the action window but exclude human approval dwell. These are real page outcomes, not physical Linux/macOS/IME tests.

| Case | Runs | p50 / p95 ms | Sample adapter requests | Outcome |
|---|---:|---:|---:|---|
| overlay removal between hit and ancestry inspection is recoverable | 20/20 | 97.5 / 180 | 61 | Supported |
| cancelled hover clears its queued agent cursor | 20/20 | 320.5 / 372 | 10 | Supported / asserted refusal |
| Control A and Backspace preserve native selection | 20/20 | 140 / 216 | 80 | Supported |
| Tab performs native focus traversal | 20/20 | 92.5 / 130 | 53 | Supported |
| Shift Tab performs reverse native focus traversal | 20/20 | 92.5 / 139 | 53 | Supported |
| coordinate wheel scrolls its nested receiver | 20/20 | 155 / 209 | 12 | Supported |
| cancelled drag stops intermediate movement and releases | 20/20 | 329.5 / 367 | 45 | Supported / asserted refusal |
| partially clipped rotated control uses a visible interior point | 20/20 | 103 / 122 | 51 | Supported |
| moving control settles before activation | 20/20 | 418.5 / 454 | 87 | Supported |
| disabled native control rejects activation | 20/20 | 7 / 23 | 22 | Supported / asserted refusal |
| unresolved frame focus fails closed for text | 20/20 | 71 / 120 | 34 | Supported / asserted refusal |
| native letter key inserts text | 20/20 | 97 / 132 | 49 | Supported |
| Unicode focused input preserves combining and astral characters | 20/20 | 66.5 / 162 | 44 | Supported |
| nested scroll container reveals its editable target | 20/20 | 93 / 117 | 57 | Supported |
| opaque target pixel changes invalidate approval before dispatch | 20/20 | 130 / 165 | 19 | Supported / asserted refusal |
| known button hover styling does not invalidate coordinate approval | 20/20 | 189.5 / 195 | 32 | Supported |
| cancelled click releases without an activation click | 20/20 | 176 / 243 | 31 | Supported / asserted refusal |
| navigation during focus cannot receive trailing fill text | 20/20 | 104.5 / 182 | 50 | Supported / asserted refusal |
| DPR 2 delivered pixels reach the pictured button | 20/20 | 233 / 330 | 32 | Supported |
| fractional DPR delivered pixels reach the pictured button | 20/20 | 204.5 / 295 | 36 | Supported |
| scrolled viewport screenshot coordinates stay viewport relative | 20/20 | 204.5 / 262 | 34 | Supported |
| coordinate mouse click reaches native button | 20/20 | 179.5 / 233 | 34 | Supported |
| coordinate hover triggers page behavior | 20/20 | 277 / 381 | 18 | Supported |
| canvas drag receives intermediate held-button moves | 20/20 | 368.5 / 393 | 54 | Supported |
| focused typing reaches visually selected field | 20/20 | 59.5 / 188 | 44 | Supported |
| Enter performs native form submission | 20/20 | 84.5 / 121 | 49 | Supported |
| late useful control survives generic-node budget pressure | 20/20 | 120 / 234 | 245 | Supported |
| readonly field rejects typing | 20/20 | 5 / 24 | 20 | Supported / asserted refusal |
| offscreen field scrolls into view | 20/20 | 92.5 / 144 | 52 | Supported |
| transient overlay disappears before click | 20/20 | 406.5 / 434 | 141 | Supported |
| post form semantics survive missing describeNode parentId | 20/20 | 74 / 116 | 47 | Supported |
| native textarea receives text | 20/20 | 90 / 130 | 52 | Supported |
| native input receives text | 20/20 | 93.5 / 131 | 52 | Supported |
| nested button receives click | 20/20 | 76 / 110 | 53 | Supported |
| author shadow descendant receives click | 20/20 | 72.5 / 112 | 49 | Supported |
| real overlay prevents activation | 20/20 | 2059 / 2104 | 559 | Supported / asserted refusal |
| nested submit performs actual form action | 20/20 | 69 / 117 | 49 | Supported |

Approval counts: this matrix invokes the adapter directly (no human approval gate). The packaged broker smoke separately verifies two coordinate approve-once dialogs, one semantic submit approval, visible target previews, fresh binary observations, focused typing, and sharing revocation. No input action is automatically retried.

Not claimed: real Google search in the installed app (requires separately authorized installation), physical pointer/IME testing, macOS, arbitrary/OOP-frame focused input, or exhaustive native select/file-picker behavior. Unresolved frame focus explicitly fails closed.
