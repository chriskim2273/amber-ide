#!/usr/bin/env python3
"""Convert a shell pane into a supervised Pi pane that resumes an exact Pi conversation.

Amber only auto-restores panes whose session kind is an agent. A `pi` the user
started by hand inside a shell pane is just a child of that shell, so a daemon
restart kills it and the pane comes back as a plain shell. This re-creates the
session as `kind=pi` with the per-session recording pre-pointed at the Pi
conversation, which is the same contract the daemon's own restore path uses.

Safety: the conversation file is never written by this script (Pi owns it); the
existing session metadata and recording are backed up first; the pane name is
preserved so the pane keeps its workspace/tab identity.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

STATE = Path('/home/poyto/.local/state/amber-ide')
SOCK = '/run/user/1000/amber-ide/amberd.sock'
AMBER = '/home/poyto/.local/bin/amber'
EVIDENCE = Path('/home/poyto/worktrees/amber-ide/pi-pane-recovery')

def amber(subcommand, *args, timeout=25):
    # `--socket` is a per-subcommand flag, not a global one.
    r = subprocess.run([AMBER, subcommand, '--socket', SOCK, *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        r = subprocess.run([AMBER, subcommand, *args, '--socket', SOCK], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"amber {' '.join(args)} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout

def listing():
    out = amber("ls")
    rows = {}
    for line in out.splitlines():
        p = line.split()
        if len(p) >= 4 and p[0].isdigit():
            rows[p[1]] = {'slot': int(p[0]), 'kind': p[3]}
    return rows

def pi_pids(slot):
    pids = []
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            if (entry / 'comm').read_text().strip() != 'pi':
                continue
            cg = (entry / 'cgroup').read_text()
            if f'session-{slot}/' in cg:
                pids.append(int(entry.name))
        except (OSError, PermissionError):
            pass
    return pids

def conversation_id(path):
    with open(path, errors='replace') as fh:
        header = json.loads(fh.readline())
    return header['id']

def convert(name, conversation, cwd, title):
    sid = conversation_id(conversation)
    before = listing()
    if name not in before:
        raise RuntimeError(f'{name} is not a live session')
    if before[name]['kind'] not in ('shell', 'pi'):
        raise RuntimeError(f'{name} is kind={before[name]["kind"]}, refusing to convert')
    slot_before = before[name]['slot']
    if before[name]['kind'] == 'shell' and pi_pids(slot_before):
        raise RuntimeError(f'{name} already runs a pi process with kind=shell; refusing')

    backup = EVIDENCE / 'before' / name
    backup.mkdir(parents=True, exist_ok=True)
    for src, label in [(STATE / 'sessions' / f'{name}.json', 'session.json'),
                       (STATE / 'claude' / f'{name}.json', 'recording.json')]:
        if src.exists():
            shutil.copy2(src, backup / label)

    amber('kill', name)
    for _ in range(100):
        if name not in listing():
            break
        time.sleep(0.1)
    else:
        raise RuntimeError(f'{name} still listed after kill')

    # The daemon removes a killed session's recording, so this must be written
    # AFTER the kill and BEFORE the create: the supervisor reads it at spawn.
    if (STATE / 'claude' / f'{name}.json').exists():
        raise RuntimeError(f'{name} recording survived the kill; ordering assumption is wrong')
    recording = {'session_id': sid, 'cwd': cwd, 'updated': int(time.time()),
                 'session_file': str(conversation), 'agent_kind': 'pi'}
    tmp = STATE / 'claude' / f'.{name}.tmp'
    tmp.write_text(json.dumps(recording, indent=2) + '\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE / 'claude' / f'{name}.json')

    args = ['create', '--kind', 'pi', '--cwd', cwd]
    if title:
        args += ['--title', title]
    args.append(name)
    amber(*args)

    for _ in range(150):
        rows = listing()
        if rows.get(name, {}).get('kind') == 'pi' and pi_pids(rows[name]['slot']):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError(f'{name} did not come back as a supervised pi pane')

    saved = json.loads((STATE / 'claude' / f'{name}.json').read_text())
    if saved.get('session_file') != str(conversation):
        raise RuntimeError(f'{name} recording moved to {saved.get("session_file")}')
    if conversation_id(conversation) != sid:
        raise RuntimeError(f'{name} conversation changed')

    return {'name': name, 'title': title, 'cwd': cwd, 'conversation': str(conversation),
            'session_id': sid, 'slot_before': slot_before, 'slot_after': rows[name]['slot'],
            'pi_pids': pi_pids(rows[name]['slot']), 'kind': rows[name]['kind']}

if __name__ == '__main__':
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    plan = json.loads(Path(sys.argv[1]).read_text())
    results = []
    for item in plan:
        print(f"==> {item['name']} <- {Path(item['conversation']).name}", flush=True)
        results.append(convert(**item))
        print(f"    ok: kind={results[-1]['kind']} slot {results[-1]['slot_before']}->{results[-1]['slot_after']} "
              f"pi pids={results[-1]['pi_pids']}", flush=True)
    (EVIDENCE / 'conversion.json').write_text(json.dumps(results, indent=2))
    print('\nconverted', len(results), 'panes')
