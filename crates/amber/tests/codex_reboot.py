"""Private daemon + fake Codex; no user configuration, authentication or API calls."""
import ctypes
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time


def wait(check, label, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (FileNotFoundError, json.JSONDecodeError, ConnectionRefusedError):
            pass
        time.sleep(.05)
    raise AssertionError('timeout: ' + label)


def fake_codex():
    ctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)
    root = Path(os.environ['AMBER_STATE_DIR'])
    args = sys.argv[2:]
    if '--dangerously-bypass-hook-trust' not in args:
        raise SystemExit('shared Codex server cannot bind this pane without embedded hooks')
    if '-C' in args:
        assert os.environ.get('AMBER_TEST_RC') == 'loaded', 'user bashrc was not loaded'
        assert '--yolo' in args, 'user alias options were not preserved'
        os.chdir(args[args.index('-C') + 1])
    sid = args[-1] if args and args[0] == 'resume' else 'exact-' + os.environ['AMBER_SESSION']
    home = Path(os.environ['CODEX_HOME'])
    hooks = json.loads((home / 'hooks.json').read_text())
    command = hooks['hooks']['SessionStart'][0]['hooks'][0]['command']
    def record():
        subprocess.run(command, shell=True, input=json.dumps({
            'session_id': sid, 'cwd': os.getcwd(), 'hook_event_name': 'SessionStart'
        }), text=True, check=True, timeout=6)
    record()
    with (root / 'launches.jsonl').open('a') as output:
        output.write(json.dumps({'pid': os.getpid(), 'id': sid, 'cwd': os.getcwd(), 'args': args}) + '\n')
    for line in sys.stdin:
        if line.strip() == 'switch':
            sid = 'selected-' + os.environ['AMBER_SESSION']
            record()
            (root / 'switched').touch()
        elif line.strip() == 'quit':
            return


def proof(binary):
    with tempfile.TemporaryDirectory(prefix='amber-codex-reboot-') as tmp:
        root = Path(tmp)
        home = root / 'home'
        codex_home = home / '.codex'
        codex_home.mkdir(parents=True)
        project = root / 'project with spaces'
        project.mkdir()
        sock = str(root / 'daemon.sock')
        fake = root / 'codex'
        fake.write_text('#!/bin/bash\nexec -a codex ' + shlex.quote(sys.executable) + ' ' + shlex.quote(__file__) + ' --fake "$@"\n')
        fake.chmod(0o755)
        (root / 'config.toml').write_text('codex_path = ' + json.dumps(str(fake)) + '\nsnapshot_interval_secs = 1\nscrollback_bytes = 4096\n[memory]\nenabled = false\n')
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'codex').symlink_to(fake)
        (home / '.bashrc').write_text('export PATH=' + shlex.quote(str(bin_dir)) + ':$PATH\nexport AMBER_TEST_RC=loaded\nalias codex=\'codex --yolo\'\n')
        env = {'HOME': str(home), 'PATH': str(bin_dir) + ':/usr/bin:/bin', 'SHELL': '/bin/bash',
               'TERM': 'xterm-256color', 'CODEX_HOME': str(codex_home),
               'XDG_STATE_HOME': str(root / 'xdg'), 'AMBER_STATE_DIR': str(root),
               'AMBER_SOCK': sock, 'AMBER_BIN': binary}
        daemon = None
        pids = []
        log = (root / 'daemon.log').open('w+')
        def send(body, expected=None):
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(3)
                connection.connect(sock)
                connection.sendall(struct.pack('>I', len(body)) + body)
                def read_exact(size):
                    data = b''
                    while len(data) < size:
                        chunk = connection.recv(size - len(data))
                        assert chunk, 'daemon closed before acknowledgement'
                        data += chunk
                    return data
                while expected:
                    size = struct.unpack('>I', read_exact(4))[0]
                    reply = read_exact(size)
                    if reply[0] == 0:
                        message = json.loads(reply[1:])
                        assert 'Error' not in message, message
                        if expected in message:
                            return
        def control(message):
            send(b'\x00' + json.dumps(message).encode(),
                 'Created' if isinstance(message, dict) and 'Create' in message else None)
        def input_line(name, line):
            name = name.encode()
            send(b'\x01' + struct.pack('>H', len(name)) + name + line.encode() + b'\n')
        def meta(name):
            return json.loads((root / 'sessions' / (name + '.json')).read_text())
        def launches():
            rows = [json.loads(line) for line in (root / 'launches.jsonl').read_text().splitlines()]
            pids.extend(row['pid'] for row in rows if row['pid'] not in pids)
            return rows
        def start():
            nonlocal daemon
            daemon = subprocess.Popen([binary, 'daemon', '--root', str(root), '--socket', sock],
                                      env=env, stdout=log, stderr=log)
            wait(lambda: (control('Hello') is None) if Path(sock).exists() else False, 'daemon socket')
        def stop(abrupt=False):
            nonlocal daemon
            if daemon and daemon.poll() is None:
                if abrupt:
                    # A real reboot kills supervisors too. Kill only descendants
                    # of this private daemon so they cannot retry into the test.
                    parents = {}
                    for entry in Path('/proc').glob('[0-9]*/stat'):
                        try:
                            fields = entry.read_text().rsplit(') ', 1)[1].split()
                            parents[int(entry.parent.name)] = int(fields[1])
                        except (OSError, ValueError, IndexError):
                            pass
                    descendants = [daemon.pid]
                    for parent in descendants:
                        descendants.extend(pid for pid, ppid in parents.items()
                                           if ppid == parent and pid not in descendants)
                    for pid in reversed(descendants[1:]):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                daemon.send_signal(signal.SIGKILL if abrupt else signal.SIGTERM)
                daemon.wait(timeout=8)
            daemon = None
        try:
            start()
            for name in ('work', 'other'):
                control({'Create': {'name': name, 'cwd': str(root), 'kind': 'shell'}})
                wait(lambda: (root / 'sessions' / (name + '.json')).exists(), 'shell creation')
                input_line(name, 'codex -C ' + shlex.quote(str(project)))
            wait(lambda: len(launches()) == 2, 'manual Codex launches')
            wait(lambda: all(meta(n).get('resume_as_codex') for n in ('work', 'other')), 'Codex snapshot flags')
            input_line('work', 'switch')
            wait(lambda: (root / 'switched').exists(), 'updated conversation recording')
            # The app disappearing must leave both PTYs alive; restart daemon
            # with agent death first, as occurs when systemd stops its cgroup.
            for pid in pids:
                os.kill(pid, signal.SIGTERM)
            stop()
            start()
            restored = wait(lambda: launches() if len(launches()) == 4 else None, 'clean restart resume')[2:]
            assert {r['id'] for r in restored} == {'selected-work', 'exact-other'}, restored
            for row in restored:
                assert row['args'][0] == 'resume' and row['args'][-2:] == ['--', row['id']], row
                assert row['cwd'] == str(project), row
                assert '--last' not in row['args'], row
            assert all(meta(n)['kind'] == 'codex' and not meta(n)['resume_as_codex'] for n in ('work', 'other'))
            # A reboot after promotion must retain the same agent and exact ids.
            for row in restored:
                os.kill(row['pid'], signal.SIGKILL)
            stop(abrupt=True)
            start()
            again = wait(lambda: launches() if len(launches()) == 6 else None, 'unclean restart resume')[4:]
            assert {r['id'] for r in again} == {'selected-work', 'exact-other'}, again
            assert all(r['cwd'] == str(project) and r['args'][0] == 'resume' for r in again), again
            print('PASS: two hand-started Codex panes, rotated recording, exact id/cwd, clean + unclean restart')
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read(), file=sys.stderr)
            for backlog in (root / 'scrollback').glob('*'):
                print(backlog.name, backlog.read_bytes().decode(errors='replace'), file=sys.stderr)
            raise
        finally:
            stop()
            for pid in pids:
                try:
                    if str(Path(__file__).resolve()).encode() in Path(f'/proc/{pid}/cmdline').read_bytes():
                        os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError, PermissionError):
                    pass
            log.close()


if __name__ == '__main__':
    if sys.argv[1] == '--fake':
        fake_codex()
    else:
        proof(str(Path(sys.argv[1]).resolve()))
