# Pi session resume operational repair — 2026-10-02

## Scope

This records a repair to live hook registrations and the installed owned Pi
extension, **not a new application-code change or binary deployment**. The
repository integration contains only this sanitized receipt and a status entry.
Unrelated implementation work, private session data, credentials, transcripts,
drafts, backup files and operator tooling are not included.

## Confirmed causes

1. A global `SessionStart` registration invoked `amberd hook`. The referenced
   artifact was daemon-only and ignored the `hook` argument. It installed a
   legacy 592-byte Pi extension and attempted restoration before rejecting an
   occupied socket. A private reproduction downgraded the modern extension
   byte-for-byte and produced an extra restore event while the primary daemon
   remained alive.
2. Obsolete worktree CLI hook targets could write legacy ID-only records over
   validated Pi recordings, dropping `session_file` and `agent_kind`. This was
   reproduced privately. The current installed CLI protects Pi recordings from
   these legacy writes, but invoking an older artifact bypassed that protection.
3. Hook garbage collection did not solve this case: it removed missing CLI
   paths, not still-existing obsolete artifacts or daemon-only hook targets.
   Repairing the extension alone therefore left the source of the downgrade
   registered.

## Repairs applied

- Backed up the affected hook registries and owned extension on private,
  persistent storage.
- Removed six obsolete Claude hook entries and one obsolete Codex entry;
  ensured each registry contained exactly one canonical installed `amber hook`
  command. Preserved all unrelated configuration and hooks.
- Reinstalled the tested **owned v10 Pi extension** through the installed CLI.
- Captured exact current session-file bindings through primary-process-validated
  Pi hooks and public Pi APIs, without choosing the newest file for a cwd.
- Saved composer drafts before live refreshes; successful nonempty draft
  round trips were verified. An offline real-Pi rehearsal covered Unicode,
  multiline text, indentation and trailing newlines without model requests.
- Did not issue a production daemon restart or kill a production Pi process.
  A host reboot occurred during the work; all old-PID input was stopped when
  the changed boot was detected. A client-closed pane was not recreated.

## Verified outcome

At the final audit, **all 12 currently live Pi panes** had:

- daemon `kind: pi` and a source-tagged `agent_kind: pi` recording;
- an absolute, existing `session_file` whose JSONL header ID matched
  `session_id`;
- matching recorded, pane and primary-process cwd;
- a recording refreshed after its current primary started;
- exactly one primary per pane and a unique session file per live pane.

The cleaned registrations and v10 extension survived the actual host reboot.
Six current conversations directly matched complete saved pre-reboot capture
receipts. This is not a claim that every original pane was automatically
restored: five current primaries were subsequently opened and recorded by their
modern hooks. Original composer backups were retained; preservation of a later
unsaved temporary editor buffer interrupted by the reboot was not certified.

### Installed-artifact validation

| Check | Result |
| --- | --- |
| All-pane private restore, installed daemon and fake Pi | 12/12 twice |
| Restore argv | Exact `--session <recorded-file>` on every launch |
| Conversation identity and cwd | Preserved in all 24 restore cases |
| Fresh-session fallback | None |
| Installed Pi reboot regression | Final run passed |
| Primary hook, explicit quit, TERM, HUP, reload/switch lifecycle tests | 5 passed, 0 failed |
| Unrelated repository baseline | 52 files hash-preserved; git status unchanged |

The private restore test cloned metadata into an isolated HOME, state directory
and socket. Fake Pi processes only read real session-file headers; they never
wrote those transcripts, loaded user authentication or called a model.

An earlier concurrent stock-fixture run exposed a test-harness race: metadata
was visible before the live session table entry existed. A private fixture copy
awaiting the authoritative `Created` acknowledgement passed three consecutive
runs; a later unmodified repository-fixture run also passed. The repository
fixture was not changed as part of this repair.

## Prevention and verification boundaries

- Production hook registrations must target the canonical current **CLI**, not
  `amberd` or obsolete development artifacts.
- Before declaring restart readiness, verify exact file/ID/cwd and primary
  identity for every listed Pi pane. An ID-only record or a running Pi process
  alone is insufficient evidence.
- Preserve drafts and pending UI interactions before using public `/reload`;
  do not blindly clear a composer or start a second writer on a live session.
- Preserve deliberate quits and client closes instead of resurrecting them.
- Private detailed evidence and backups remain outside Git. This receipt
  deliberately omits live session IDs, filenames, machine paths and PIDs.

Verification applies to the installed Linux artifact and the audited bindings
at that time. It does not certify a future build, changed hook registrations,
macOS behavior or provider availability. The installed artifact contained
existing working-tree work; this documentation-only integration does not merge
that unrelated source work or establish a new reproducible release artifact.
