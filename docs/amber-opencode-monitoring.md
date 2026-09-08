# Amber/OpenCode Session Monitoring Runbook

Purpose: inspect every Amber session's real terminal contents and resume only
OpenCode sessions that stopped mid-task. Amber's `kind` column is not reliable:
it may report `shell` while a shell is running OpenCode.

## Safety rules

- Never use `script`, `timeout`, `kill`, EOF, or a pipeline that closes the
  attach client's stdin against a real session. These can send SIGHUP/EOF into
  the pane and terminate OpenCode.
- Before experimenting with attach behavior, create and later kill a
  disposable Amber session.
- Attach through a real PTY (`tty: true` in the tool/API).
- Detach only with the Amber protocol: `Ctrl-b d` (`\x02d`).
- Use carriage return (`\r`) for OpenCode's Enter key. A line feed (`\n`) can
  appear as a new line without submitting the prompt.
- Never send `Ctrl-c`, `Ctrl-d`, `exit`, `quit`, `q`, or any other end input to
  a monitored OpenCode pane.

## 1. Get the current inventory

Run:

```sh
amber ls
ps -eo pid,ppid,stat,etime,args | rg 'opencode' | rg -v 'rg '
```

Record the stable slot number from `amber ls`. Attach by slot, not by inferred
ordinal/name. Example:

```text
2  amber-1-1-1-mt4bfk3u2  ~/Projects/rubber-ducky-app  shell
```

Here `2` is the attach target. The displayed `shell` is only a daemon process
kind, not proof that the pane is idle.

## 2. Validate the attach method in a disposable session

Use a unique name and a disposable working directory:

```sh
NAME="amber-disposable-monitor-$(date +%s)"
amber create --cwd /tmp "$NAME"
```

Start an interactive attach in a real PTY:

```sh
amber attach "$NAME" --no-status
```

Verify normal Enter behavior with `echo ENTER_TEST` followed by carriage
return (`\r`). Then detach by sending exactly:

```text
Ctrl-b d
```

The attach client must print `detached from ...` and exit successfully. Clean
up the disposable session:

```sh
amber kill "$NAME"
```

Confirm no disposable row remains:

```sh
amber ls | rg disposable || true
```

## 3. Manually inspect each live slot

For each slot from `amber ls`, one at a time:

```sh
amber attach <SLOT> --no-status
```

Read the actual current OpenCode screen, including its prompt/status area and
recent task output. Do not infer state from `amber ls`.

Check in this order:

1. Is there a Quick Recap output? If yes, leave session alone.
2. If not, inspect the status line. Examples:

   ```text
   Build · Ox Alpha
   Build · Ox Alpha · 3m 1
   ```

3. A timestamp suffix means task was in progress and stopped/stalled. Send
   exactly `continue` followed by carriage return (`continue\r`).
4. If there is no timestamp, send nothing.
5. If screen says `interrupted`, send nothing unless separately instructed.
6. If pane is an ordinary shell with no OpenCode UI, send nothing.

After every inspection, detach explicitly with `Ctrl-b d` and verify the
`detached from ...` confirmation before moving to the next slot.

## 4. Sending continue safely

In the interactive PTY for a confirmed stalled slot, write these bytes:

```text
continue\r
```

Wait briefly for the status line to change from the timestamped form to an
active form (normally no timestamp or an active spinner), then detach with:

```text
Ctrl-b d  =  \x02d
```

Never use `continue\n`; that was observed to insert a new line rather than
submit the OpenCode prompt.

## 5. Optional read-only corroboration

Process list is corroboration only; terminal inspection remains authoritative:

```sh
ps -eo pid,ppid,stat,etime,args | rg 'opencode' | rg -v 'rg '
```

OpenCode stores session history in a SQLite database. Read it read-only if the
screen is ambiguous:

```sh
python3 - <<'PY'
import sqlite3

path = '/home/poyto/.local/share/opencode/opencode.db'
db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
for name, sql in db.execute("""
    select name, sql from sqlite_master
    where type = 'table' and name in ('session', 'message', 'part')
    order by name
"""):
    print(name, sql)
PY
```

Useful evidence:

- Latest assistant message has `error.name = MessageAbortedError`: likely
  stopped, but still verify screen before resuming.
- Latest assistant message has `finish = stop`: completed; do not resume merely
  because no quick recap is visible.
- Search latest `part` rows for quick-recap text, then use the screen status
  line to decide whether a timestamp remains.

## 6. Final verification

Run:

```sh
amber ls
amber ls | rg disposable || true
ps -eo pid,ppid,stat,etime,args | rg 'opencode' | rg -v 'rg '
```

Expected: all original Amber rows remain, no disposable row remains, and no
OpenCode process disappeared during monitoring.

## Incident history

On 2026-08-22, a `script` + `timeout` probe caused hangups and terminated
multiple OpenCode processes. This is why the explicit-PTY/explicit-detach
procedure above is mandatory.
