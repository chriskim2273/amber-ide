"""Private daemon + fake Pi. No installed Pi, user extensions, auth or LLM calls."""
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


def fake_pi():
    ctypes.CDLL(None).prctl(15, b"pi", 0, 0, 0)
    root = Path(os.environ['AMBER_STATE_DIR'])
    args = sys.argv[2:]
    child = '--child' in args
    path = Path(args[args.index('--session') + 1]) if '--session' in args else root / ('child.jsonl' if child else 'parent.jsonl')
    sid = 'child-session' if child else 'parent-session'
    if not path.exists():
        path.write_text(json.dumps({'type': 'session', 'id': sid, 'cwd': os.getcwd()}) + '\n')
    sid = json.loads(path.open().readline())['id']
    def hook(event, legacy=False):
        payload = {'event': event, 'agent_kind': 'pi', 'session_id': sid,
                   'session_file': str(path), 'cwd': os.getcwd(), 'pid': os.getpid()}
        if legacy:
            payload.pop('agent_kind')
        subprocess.run([os.environ['AMBER_BIN'], 'hook'], input=json.dumps(payload),
                       text=True, check=True, timeout=6)
    hook('start')
    if child:
        hook('start', legacy=True)  # an old child extension must not clobber either
        return
    with (root / 'launches.jsonl').open('a') as f:
        f.write(json.dumps({'pid': os.getpid(), 'path': str(path), 'id': sid, 'cwd': os.getcwd(), 'args': args}) + '\n')
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    for line in sys.stdin:
        if line.strip() == 'child':
            subprocess.run([sys.executable, __file__, '--fake', '--child'], check=True)
            (root / 'child-done').touch()
        elif line.strip() == 'switch':
            path = root / 'forks' / 'selected-main.jsonl'
            path.parent.mkdir(exist_ok=True)
            sid = 'selected-main-session'
            path.write_text(json.dumps({'type': 'session', 'id': sid, 'cwd': os.getcwd()}) + '\n')
            hook('start')
            (root / 'switched').touch()
        elif line.strip() == 'quit':
            hook('quit')
            (root / 'quit-acknowledged').touch()
            return


def wait(check, label, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            result = check()
            if result:
                return result
        except (FileNotFoundError, json.JSONDecodeError, ConnectionRefusedError):
            pass
        time.sleep(.05)
    raise AssertionError('timeout: ' + label)


def proof(binary):
    with tempfile.TemporaryDirectory(prefix='amber-pi-proof-') as tmp:
        root = Path(tmp)
        home = root / 'home'
        home.mkdir()
        cwd = root / 'project with spaces'
        cwd.mkdir()
        sock = str(root / 'daemon.sock')
        fake = root / 'pi'
        fake.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(__file__) + ' --fake "$@"\n')
        fake.chmod(0o755)
        (root / 'config.toml').write_text('pi_path = ' + json.dumps(str(fake)) + '\nsnapshot_interval_secs = 1\nscrollback_bytes = 4096\n[memory]\nenabled = false\n')
        env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/sh', 'TERM': 'xterm-256color',
               'XDG_STATE_HOME': str(root / 'xdg'), 'XDG_CONFIG_HOME': str(home / '.config'),
               'PI_CODING_AGENT_DIR': str(home / '.pi/agent'), 'CODEX_HOME': str(home / '.codex'),
               'AMBER_STATE_DIR': str(root), 'AMBER_SOCK': sock, 'AMBER_BIN': binary}
        daemon = None
        pids = []
        log = (root / 'daemon.log').open('w+')
        def control(msg):
            body = b'\x00' + json.dumps(msg).encode()
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(3)
                s.connect(sock)
                s.sendall(struct.pack('>I', len(body)) + body)
        def input_line(line):
            name = b'work'
            body = b'\x01' + struct.pack('>H', len(name)) + name + line.encode() + b'\n'
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(3)
                s.connect(sock)
                s.sendall(struct.pack('>I', len(body)) + body)
        def recording():
            return json.loads((root / 'claude/work.json').read_text())
        def launches():
            return [json.loads(s) for s in (root / 'launches.jsonl').read_text().splitlines()]
        def start():
            nonlocal daemon
            daemon = subprocess.Popen([binary, 'daemon', '--root', str(root), '--socket', sock], env=env, stdout=log, stderr=log)
            wait(lambda: (control('Hello') is None) if Path(sock).exists() else False, 'daemon socket')
        def stop():
            nonlocal daemon
            if daemon and daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=8)
            daemon = None
        try:
            start()
            control({'Create': {'name': 'work', 'cwd': str(cwd), 'kind': 'shell'}})
            wait(lambda: (root / 'sessions/work.json').exists(), 'shell creation')
            input_line(shlex.quote(str(fake)))
            wait(lambda: len(launches()) == 1, 'manual Pi start')
            pids.append(launches()[-1]['pid'])
            assert recording().get('session_file') == str(root / 'parent.jsonl'), recording()
            input_line('child')
            wait(lambda: (root / 'child-done').exists(), 'nested child hooks')
            assert recording()['session_id'] == 'parent-session', 'nested child overwrote parent'
            input_line('switch')
            wait(lambda: (root / 'switched').exists(), 'main session fork switch')
            assert recording()['session_file'] == str(root / 'forks/selected-main.jsonl')
            # Signal the agent before the daemon, as system shutdown can do.
            os.kill(pids[-1], signal.SIGTERM)
            time.sleep(2.2)  # periodic snapshots must not confuse signal exit with quit
            assert recording().get('agent_kind') == 'pi'
            stop()
            start()
            wait(lambda: len(launches()) == 2, 'exact-file Pi restoration')
            restored = launches()[-1]
            pids.append(restored['pid'])
            assert restored['args'] == ['--session', str(root / 'forks/selected-main.jsonl')], restored
            assert restored['cwd'] == str(cwd), restored
            assert recording()['session_id'] == 'selected-main-session'
            # Explicit quit must synchronously clear before an immediate restart.
            input_line('quit')
            wait(lambda: (root / 'quit-acknowledged').exists(), 'intentional quit acknowledgement')
            assert recording().get('agent_kind') is None
            assert json.loads((root / 'sessions/work.json').read_text())['kind'] == 'shell'
            stop()
            start()
            time.sleep(1)
            assert len(launches()) == 2, 'deliberately quit Pi was resurrected'
            print('PASS: primary hooks, nested legacy hooks, TERM-before-daemon, exact file/cwd reboot, deliberate quit')
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            stop()
            for pid in pids:
                try:
                    # Only our fixture process, never a reused/unrelated PID.
                    if Path(f'/proc/{pid}/comm').read_text().strip() == 'pi' and str(root).encode() in Path(f'/proc/{pid}/environ').read_bytes():
                        os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError):
                    pass
            log.close()


if __name__ == '__main__':
    if sys.argv[1] == '--fake':
        fake_pi()
    else:
        proof(str(Path(sys.argv[1]).resolve()))
