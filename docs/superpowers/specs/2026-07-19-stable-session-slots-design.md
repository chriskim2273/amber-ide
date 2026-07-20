# Stable session slots — design

**Date:** 2026-07-19
**Status:** implemented + live-verified 2026-07-19.
**Supersedes:** the positional `amber ls` index and `amber attach <n>` index
resolution (`attach::pick_by_index`), shipped earlier today alongside the pane
`#index` header.

## 0. Problem

The number shown in a pane header (and printed by `amber ls`) is currently the
session's **position** in the by-name sorted list. Killing a session renumbers
every session after it, so a number the user memorised — or is reading off a
pane header while typing `amber attach 3` — can silently point at a different
session.

## 1. Settled decisions (user, 2026-07-19)

| Question | Decision |
|---|---|
| Allocation | **Lowest free number.** A new session takes the smallest positive integer not held by any session the daemon still lists (see §2 — dead-not-reaped sessions keep theirs). Numbers stay small; a freed number can be reused later by a NEW session. |
| CLI | **Slots replace positional indices.** `amber ls` prints the slot; `amber attach <n>` resolves by slot. There is exactly ONE number in the system — header, `ls`, and `attach` all agree. |

Accepted tradeoff of "lowest free": after killing `#2`, the next created session
becomes `#2`. Stale muscle memory can therefore reach a *different* session —
but only after a create, never spontaneously as today.

## 2. Model

- A **slot** is a `u32 >= 1`, owned by the daemon, unique across **every session
  the daemon knows about — dead-but-not-yet-reaped included**, not merely the
  live ones. `ls`/`attach`/the app all list a dead session until it is reaped
  (that is what renders the "exited · close pane" overlay), so allocating against
  live sessions only would hand its number to a new session and produce two
  `#2`s — reintroducing the very ambiguity this feature removes. A slot frees
  when the session LEAVES the map (reap/close), not when its process dies.
- It is assigned at creation, persisted in `SessionMeta`, and **survives**:
  a daemon restart (restored from the store), a `Rename` (slots key off the
  session, not the name), and any other session's death.
- It is NOT a global unique id: a slot freed by a kill may later be reused.
  (Monotonic-forever was rejected: unbounded growth for a long-lived daemon.)

## 3. Daemon changes (Rust)

### 3.1 `SessionMeta.slot: u32` — `amber-core/src/state.rs`
`#[serde(default)]` so older records decode as `0` = "unassigned".

### 3.2 Allocation — `amber/src/manager.rs`
- `fn alloc_slot(&taken) -> u32`: smallest integer `>= 1` not present. Pure,
  unit-tested (empty set → 1; `{1,2,4}` → 3; contiguous → n+1). `taken` is built
  from the FULL session map (see §2 — dead-not-reaped sessions still hold theirs).
- `create()` assigns from the full session map, then persists.
- `restore()` keeps each session's stored slot; **repairs** as it goes, because
  the store is user-visible JSON and can be hand-edited or predate this change:
  a `0`/missing slot, or one already taken by an earlier-restored session, is
  reassigned via `alloc_slot`. Restore order is by name so repair is
  deterministic.
- `rename()` carries the slot across unchanged.

### 3.3 Wire — `amber-core/src/proto.rs`
`SessionInfo.slot: u32` with `#[serde(default)]` (additive; the app tolerates
unknown/missing fields, so no lockstep release is required).

### 3.4 CLI — `amber/src/main.rs`, `amber/src/attach.rs`
- `run_ls` prints the **slot**, not the enumeration position. Keep the by-name
  sort for the listing order (stable, readable); only the printed number changes.
  Width-pad to the widest slot.
- `attach::pick_by_index` → `pick_by_slot(sessions, slot)`: match on
  `info.slot`, no positional fallback (a positional fallback would resurrect the
  exact ambiguity this removes). Unknown slot → the existing "no such session"
  error path.
- `amber attach <n>` therefore means "the session whose slot is n".

## 4. App changes (TypeScript)

- `shared/proto.ts`: decode `slot` on `SessionInfo` (decode-only, like `updated`).
- `renderer/store.ts`: **delete** `sessionIndex` (positional) — the header must
  not compute a number of its own. The slot arrives on the session record.
- `renderer/tabView.ts`: `deriveTab` takes the slot from the pane's session info
  and renders `#<slot> <title>`; a pane with slot `0`/absent (older daemon)
  renders with no prefix rather than a wrong number.

## 5. Testing

- **Rust unit:** `alloc_slot` (empty, gap, contiguous); `create` assigns
  lowest-free; a session that is DEAD but still listed keeps its slot (a new
  create must not take it) and it frees only once the session is removed;
  `rename`
  preserves it; `restore` keeps stored slots and repairs missing/duplicate ones.
- **Rust integration (live daemon):** create 3 → kill the middle one → the other
  two keep their numbers (this is the regression this feature exists for);
  restart the daemon → slots unchanged; `attach <slot>` reaches the right
  session.
- **App unit:** the title prefix uses the slot, and is omitted when the slot is
  absent.
- **Live GUI:** headers match `amber ls`; killing a session does NOT renumber the
  others; `amber attach <n>` typed in a terminal lands in the pane showing `#n`;
  and — the case a clean create/kill/create test misses — with a pane left in the
  DEAD-but-not-reaped state (`exit` in the shell, overlay still reading `#2`),
  creating a new pane must NOT hand it that same number.

## 6. Out of scope

User-assignable/renamable slots, slots for app-local panes (browser/editor have
no daemon session), and any per-workspace numbering.
