# Task 1 report: provider-correct renderer reload commands

## Implementation

- Added `reloadAgentCommand` with provider-specific Claude, Grok, and Codex command construction.
- Codex exact IDs are shell-quoted and reject blank/control-character values; Codex picker mode uses `codex resume` without `--last`.
- Preserved Claude/Grok UUID validation and command syntax.
- Routed `SplitView` reload actions through the helper and changed copy from “Resume last” to “Resume saved”; Codex picker copy no longer claims `--last`.

## Files

- `app/src/renderer/reloadAgent.ts`
- `app/src/renderer/reloadAgent.test.ts`
- `app/src/renderer/SplitView.tsx`

## TDD RED

Command:

```text
npm test --prefix app -- --run src/renderer/reloadAgent.test.ts
```

Output: failed during suite loading because `./reloadAgent` did not exist.

## TDD GREEN

Command:

```text
npm test --prefix app -- --run src/renderer/reloadAgent.test.ts
```

Output: `src/renderer/reloadAgent.test.ts (10 tests)` passed.

Command:

```text
npm run typecheck --prefix app
```

Output: renderer and node TypeScript projects completed with `tsc --noEmit` and no errors.

## Tests

Focused reload command tests: 10 passed.

Typecheck: passed.

## Self-review

- `git diff --check`: passed.
- The shell trust boundary is centralized in the pure helper; SplitView no longer duplicates validation or provider command assembly.
- No unrelated files were changed.

## Concerns

None identified within the scoped task.
