import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  sshTunnelArgv, sshProbeArgv, isValidHost, localSocketPath, hostLabel,
  REMOTE_SOCKET_PROBE, REMOTE_LAYOUT_PROBE, REMOTE_LAYOUT_PROBE_MAX_BYTES,
  parseAgentSock, explainSshFailure, isSupportedOnPlatform, runSshProbe,
  waitForSshTunnelReady,
  type SshProbeChild,
  type SshTunnelReadinessChild,
} from './sshRemote'

const execFile = promisify(execFileCallback)

describe('sshTunnelArgv', () => {
  const a = sshTunnelArgv('me@box', '/tmp/w/remote.sock', '/run/user/1000/amber-ide/amberd.sock')

  it('forwards the remote socket to the local one', () => {
    expect(a.cmd).toBe('ssh')
    expect(a.args).toContain('-L')
    expect(a.args).toContain('/tmp/w/remote.sock:/run/user/1000/amber-ide/amberd.sock')
    expect(a.args[a.args.length - 1]).toBe('me@box')
  })

  it('fails loudly when the forward cannot bind', () => {
    // Without this a tunnel that never forwarded looks identical to a daemon
    // that is not running, and the window blames the wrong thing.
    expect(a.args.join(' ')).toContain('ExitOnForwardFailure=yes')
  })

  it('lets a dead network drop the child instead of hanging', () => {
    expect(a.args.join(' ')).toContain('ServerAliveInterval=15')
    expect(a.args.join(' ')).toContain('ServerAliveCountMax=3')
  })

  it('never weakens host key verification', () => {
    // amber must not decide the user's trust policy for them.
    expect(a.args.join(' ')).not.toContain('StrictHostKeyChecking')
    expect(a.args.join(' ')).not.toContain('UserKnownHostsFile')
  })

  it('requests no remote command and no pty', () => {
    expect(a.args).toContain('-N')
    expect(a.args).toContain('-T')
  })
})

class FakeProbeChild extends EventEmitter implements SshProbeChild, SshTunnelReadinessChild {
  readonly stdout = new EventEmitter()
  readonly stderr: EventEmitter & { resume: () => void }
  readonly killed: Array<NodeJS.Signals | undefined> = []
  resumed = 0
  constructor() {
    super()
    this.stderr = new EventEmitter() as EventEmitter & { resume: () => void }
    this.stderr.resume = () => { this.resumed += 1 }
  }
  kill(signal?: NodeJS.Signals): boolean { this.killed.push(signal); return true }
}

describe('waitForSshTunnelReady', () => {
  it('cleans the poll, process listeners, and stderr capture after success', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeProbeChild(); let ready = false; let polls = 0
      const waiting = waitForSshTunnelReady(child, '/tmp/remote.sock', {
        timeoutMs: 100,
        pollMs: 10,
        maxStderrBytes: 64,
        exists: () => { polls += 1; return ready },
      })
      child.stderr.emit('data', Buffer.from('before-ready\n'))
      ready = true
      await vi.advanceTimersByTimeAsync(10)
      await expect(waiting).resolves.toEqual({ ready: true, reason: 'ready', stderr: 'before-ready\n' })
      const afterReadyPolls = polls
      child.stderr.emit('data', Buffer.from('after-ready\n'))
      await vi.advanceTimersByTimeAsync(100)
      expect(polls).toBe(afterReadyPolls)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.resumed).toBe(1)
    } finally { vi.useRealTimers() }
  })

  it('cleans all listeners when ssh exits before the socket appears', async () => {
    const child = new FakeProbeChild()
    const waiting = waitForSshTunnelReady(child, '/tmp/remote.sock', { timeoutMs: 100, exists: () => false })
    child.stderr.emit('data', Buffer.from('forward failed\n'))
    child.emit('exit', 255)
    await expect(waiting).resolves.toEqual({ ready: false, reason: 'exit', stderr: 'forward failed\n' })
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.resumed).toBe(1)
  })

  it('cleans all listeners when ssh reports a spawn error', async () => {
    const child = new FakeProbeChild()
    const waiting = waitForSshTunnelReady(child, '/tmp/remote.sock', { timeoutMs: 100, exists: () => false })
    child.emit('error', new Error('ENOENT'))
    await expect(waiting).resolves.toEqual({ ready: false, reason: 'error', stderr: '' })
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.resumed).toBe(1)
  })

  it('cleans all listeners on timeout and caps retained stderr', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeProbeChild()
      const waiting = waitForSshTunnelReady(child, '/tmp/remote.sock', { timeoutMs: 5, pollMs: 1, maxStderrBytes: 8, exists: () => false })
      child.stderr.emit('data', Buffer.from('1234567890'))
      await vi.advanceTimersByTimeAsync(5)
      await expect(waiting).resolves.toEqual({ ready: false, reason: 'timeout', stderr: '12345678' })
      child.stderr.emit('data', Buffer.from('late stderr'))
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.resumed).toBe(1)
    } finally { vi.useRealTimers() }
  })
})

describe('sshProbeArgv', () => {
  it('never blocks on an interactive prompt', () => {
    // A probe that sits waiting for a password would hang the window's open.
    const p = sshProbeArgv('box', REMOTE_SOCKET_PROBE)
    expect(p.args.join(' ')).toContain('BatchMode=yes')
    expect(p.args.join(' ')).toContain('ConnectTimeout=10')
    expect(p.args[p.args.length - 1]).toBe(REMOTE_SOCKET_PROBE)
  })

  it('quotes complete remote XDG and HOME paths while preserving remote expansion', () => {
    expect(REMOTE_SOCKET_PROBE).toContain('"${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/amber-ide/amberd.sock}"')
    expect(REMOTE_SOCKET_PROBE).toContain('"$HOME/.local/state/amber-ide/amberd.sock"')
    expect(REMOTE_SOCKET_PROBE).toContain('printf "%s\\n" "$p"')
    expect(REMOTE_LAYOUT_PROBE).toContain('"${XDG_STATE_HOME:-$HOME/.local/state}/amber-ide/ui-layout.json"')
    const argv = sshProbeArgv('box', REMOTE_LAYOUT_PROBE)
    expect(argv.args.at(-1)).toBe(REMOTE_LAYOUT_PROBE)
  })

  it('expands remote paths containing spaces and glob characters as data', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber ssh probe [root] '))
    try {
      const runtime = join(root, 'runtime [*]'), home = join(root, 'home [*]'), state = join(root, 'state [*]')
      const socket = join(runtime, 'amber-ide', 'amberd.sock')
      const layout = join(state, 'amber-ide', 'ui-layout.json')
      await mkdir(join(runtime, 'amber-ide'), { recursive: true })
      await mkdir(join(state, 'amber-ide'), { recursive: true })
      await writeFile(socket, '')
      await writeFile(layout, '{"safe":true}')
      const env = { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: state, HOME: home }
      const socketResult = await execFile('/bin/sh', ['-c', REMOTE_SOCKET_PROBE], { env })
      const layoutResult = await execFile('/bin/sh', ['-c', REMOTE_LAYOUT_PROBE], { env })
      expect(socketResult.stdout.trim()).toBe(socket)
      expect(layoutResult.stdout).toBe('{"safe":true}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates a noncooperative child and forwards no partial layout on overflow', async () => {
    const child = new FakeProbeChild()
    const probe = runSshProbe('box', REMOTE_LAYOUT_PROBE, {}, { maxBytes: REMOTE_LAYOUT_PROBE_MAX_BYTES, timeoutMs: 100 }, {
      spawn: () => child,
    })
    child.stdout.emit('data', Buffer.alloc(REMOTE_LAYOUT_PROBE_MAX_BYTES + 1, 0x78))
    await expect(probe).resolves.toMatchObject({ out: '', err: '', code: -1, error: 'LAYOUT_FILE_LIMIT' })
    expect(child.killed).toEqual(['SIGKILL'])
    child.stdout.emit('data', Buffer.from('partial-after-failure'))
  })

  it('bounds combined stdout and stderr, never just one stream', async () => {
    const child = new FakeProbeChild()
    const probe = runSshProbe('box', REMOTE_LAYOUT_PROBE, {}, { maxBytes: 8, timeoutMs: 100 }, {
      spawn: () => child,
    })
    child.stderr.emit('data', Buffer.alloc(8, 0x65))
    child.stdout.emit('data', Buffer.from('x'))
    await expect(probe).resolves.toMatchObject({ out: '', err: '', code: -1, error: 'LAYOUT_FILE_LIMIT' })
    expect(child.killed).toEqual(['SIGKILL'])
  })

  it('terminates a noncooperative child on the wall-clock timeout', async () => {
    const child = new FakeProbeChild()
    const probe = runSshProbe('box', REMOTE_LAYOUT_PROBE, {}, { maxBytes: REMOTE_LAYOUT_PROBE_MAX_BYTES, timeoutMs: 5 }, {
      spawn: () => child,
    })
    await expect(probe).resolves.toMatchObject({ out: '', err: '', code: -1, error: 'SSH_PROBE_TIMEOUT' })
    expect(child.killed).toEqual(['SIGKILL'])
  })

  it('rejects distinct invalid UTF-8 output with one stable error and no text', async () => {
    const first = new FakeProbeChild()
    const firstProbe = runSshProbe('box', REMOTE_LAYOUT_PROBE, {}, { maxBytes: 32, timeoutMs: 100 }, { spawn: () => first })
    first.stdout.emit('data', Buffer.from([0xc3, 0x28])); first.emit('close', 0)
    await expect(firstProbe).resolves.toMatchObject({ out: '', err: '', code: -1, error: 'LAYOUT_INVALID_UTF8' })

    const second = new FakeProbeChild()
    const secondProbe = runSshProbe('box', REMOTE_LAYOUT_PROBE, {}, { maxBytes: 32, timeoutMs: 100 }, { spawn: () => second })
    second.stdout.emit('data', Buffer.from([0xe2, 0x28, 0xa1])); second.emit('close', 0)
    await expect(secondProbe).resolves.toMatchObject({ out: '', err: '', code: -1, error: 'LAYOUT_INVALID_UTF8' })
  })
})

describe('isValidHost', () => {
  it('accepts ordinary hosts and ssh_config aliases', () => {
    for (const h of ['box', 'me@box', 'box.local', 'me@10.0.0.4', 'work-jump', 'me@[fe80::1]']) {
      expect(isValidHost(h), h).toBe(true)
    }
  })

  it('rejects anything ssh would read as an OPTION', () => {
    // `-oProxyCommand=...` as a host executes an arbitrary LOCAL command.
    expect(isValidHost('-oProxyCommand=touch /tmp/pwned')).toBe(false)
    expect(isValidHost('--')).toBe(false)
  })

  it('rejects shell metacharacters and whitespace', () => {
    for (const h of ['box; rm -rf /', 'box $(id)', 'box `id`', 'a b', 'box|tee', "box'"]) {
      expect(isValidHost(h), h).toBe(false)
    }
  })

  it('rejects empty and absurd input', () => {
    expect(isValidHost('')).toBe(false)
    expect(isValidHost('x'.repeat(256))).toBe(false)
  })
})

describe('localSocketPath / hostLabel', () => {
  it('puts the socket inside the window private dir', () => {
    expect(localSocketPath('/tmp/w')).toBe(join('/tmp/w', 'remote.sock'))
  })
  it('labels a window by host, dropping the user', () => {
    expect(hostLabel('me@box.local')).toBe('box.local')
    expect(hostLabel('box')).toBe('box')
  })
})

describe('parseAgentSock', () => {
  it('finds the agent socket in show-environment output', () => {
    const out = 'LANG=en_US.UTF-8\nSSH_AUTH_SOCK=/run/user/1000/keyring/ssh\nDISPLAY=:1\n'
    expect(parseAgentSock(out)).toBe('/run/user/1000/keyring/ssh')
  })
  it('returns null when absent or empty', () => {
    expect(parseAgentSock('DISPLAY=:1\n')).toBeNull()
    expect(parseAgentSock('SSH_AUTH_SOCK=\n')).toBeNull()
  })
  it('does not match a key that merely ends with the name', () => {
    expect(parseAgentSock('XSSH_AUTH_SOCK=/nope\n')).toBeNull()
  })
})

describe('explainSshFailure', () => {
  it('names the missing agent, which ssh reports only as permission denied', () => {
    const msg = explainSshFailure('poyto@localhost: Permission denied (publickey,password).', false)
    expect(msg).toContain('No ssh agent')
    expect(msg).toContain('import-environment SSH_AUTH_SOCK')
  })
  it('stays out of the way when an agent WAS available', () => {
    // Then permission-denied means what it says, and ssh's own text is better.
    expect(explainSshFailure('Permission denied (publickey).', true)).toBeNull()
  })
  it('stays out of the way for unrelated failures', () => {
    expect(explainSshFailure('ssh: Could not resolve hostname box', false)).toBeNull()
  })
})

describe('isSupportedOnPlatform', () => {
  it('declares remote SSH unsupported on Windows', () => {
    expect(isSupportedOnPlatform('win32')).toEqual({
      ok: false,
      reason: expect.stringContaining('named pipe'),
    })
  })

  it('keeps SSH remote windows available on Unix platforms', () => {
    expect(isSupportedOnPlatform('linux')).toEqual({ ok: true })
    expect(isSupportedOnPlatform('darwin')).toEqual({ ok: true })
  })
})
