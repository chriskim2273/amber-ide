import { describe, it, expect } from 'vitest'
import {
  sshTunnelArgv, sshProbeArgv, isValidHost, localSocketPath, hostLabel,
  REMOTE_SOCKET_PROBE, parseAgentSock, explainSshFailure,
} from './sshRemote'

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

describe('sshProbeArgv', () => {
  it('never blocks on an interactive prompt', () => {
    // A probe that sits waiting for a password would hang the window's open.
    const p = sshProbeArgv('box', REMOTE_SOCKET_PROBE)
    expect(p.args.join(' ')).toContain('BatchMode=yes')
    expect(p.args.join(' ')).toContain('ConnectTimeout=10')
    expect(p.args[p.args.length - 1]).toBe(REMOTE_SOCKET_PROBE)
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
    expect(localSocketPath('/tmp/w')).toBe('/tmp/w/remote.sock')
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
