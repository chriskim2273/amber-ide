// SSH remote windows (spec 2026-08-23).
//
// The app's client already connects to a unix socket path taken from the
// environment, so "open another machine's amber" needs no new protocol: forward
// that socket with ssh, fork a client pointed at the local end, give it a
// window.
//
// Everything here is pure. Process spawning and window wiring live in
// `index.ts`; this module exists so the argv — which carries the security
// posture — is testable.

import { join } from 'node:path'

/** Where the remote daemon's socket is, per `resolveSocketPath`'s own rules. */
export const REMOTE_SOCKET_PROBE =
  'ls ${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/amber-ide/amberd.sock} ' +
  '"$HOME/.local/state/amber-ide/amberd.sock" 2>/dev/null | head -1'

/** Where the remote layout sidecar is. Same derivation, different file. */
export const REMOTE_LAYOUT_PROBE =
  'cat ${XDG_STATE_HOME:-$HOME/.local/state}/amber-ide/ui-layout.json 2>/dev/null'

export interface Argv {
  cmd: string
  args: string[]
}

export type SshRemoteSupport =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Windows OpenSSH cannot be assumed to forward Amber's named pipe. Keep the
 * feature discoverable, but never start a tunnel that cannot carry the local
 * transport.
 */
export function isSupportedOnPlatform(platform: NodeJS.Platform): SshRemoteSupport {
  if (platform === 'win32') {
    return {
      ok: false,
      reason: 'Remote SSH windows are unavailable on Windows because Amber uses a named pipe, not a Unix socket that OpenSSH can forward.',
    }
  }
  return { ok: true }
}

/**
 * Argv for the tunnel itself.
 *
 * Deliberate choices, each load-bearing:
 * - `ExitOnForwardFailure=yes` — a forward that cannot bind must be a reportable
 *   error, not a silently useless tunnel the window then blames on the daemon.
 * - `ServerAliveInterval`/`CountMax` — a dead network drops the child in ~45s
 *   instead of hanging forever; the window has to learn it went away.
 * - `-N -T` — no remote command, no pty. We only want the forward.
 * - NOTHING about host keys. amber never passes `StrictHostKeyChecking=no`;
 *   verification stays exactly as the user configured it.
 */
export function sshTunnelArgv(host: string, localSock: string, remoteSock: string): Argv {
  return {
    cmd: 'ssh',
    args: [
      '-N',
      '-T',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${localSock}:${remoteSock}`,
      host,
    ],
  }
}

/** Argv for a one-shot probe command on the remote. */
export function sshProbeArgv(host: string, script: string): Argv {
  return {
    cmd: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, script],
  }
}

/**
 * A host string is passed straight to ssh, so it must not be able to smuggle
 * options. `-oProxyCommand=…` as a "host" would execute an arbitrary local
 * command; ssh treats a leading `-` as a flag no matter where it appears in
 * our args array.
 */
export function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false
  if (host.startsWith('-')) return false
  // user@host, host, host with an ssh_config alias. No spaces, no shell
  // metacharacters — those would be a quoting bug waiting to happen.
  return /^[A-Za-z0-9._@%+:\-[\]]+$/.test(host) && !host.includes('--')
}

/** Local end of the tunnel, inside a per-window private directory. */
export function localSocketPath(dir: string): string {
  return join(dir, 'remote.sock')
}

/** A short, stable label for a window title / read-only marker. */
export function hostLabel(host: string): string {
  const at = host.lastIndexOf('@')
  return at === -1 ? host : host.slice(at + 1)
}

/**
 * Pick `SSH_AUTH_SOCK` out of `systemctl --user show-environment` output.
 *
 * Why this exists: an app started from a desktop launcher (or a systemd user
 * unit) can inherit an environment with NO ssh agent, and then every host is
 * "Permission denied (publickey)" no matter how well the user's ssh works in a
 * terminal. Measured here: the app process had no `SSH_AUTH_SOCK` at all.
 *
 * Exactly the same class as the 2026-07-29 display-env fix, which reads
 * `DISPLAY`/`WAYLAND_DISPLAY` from the same place for the same reason — the
 * minimal env a service inherits is not the env a user-facing action needs.
 */
export function parseAgentSock(showEnvironment: string): string | null {
  for (const line of showEnvironment.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq) !== 'SSH_AUTH_SOCK') continue
    const v = line.slice(eq + 1).trim()
    return v.length > 0 ? v : null
  }
  return null
}

/**
 * A human explanation for an ssh failure, or null to fall back to ssh's own
 * stderr (which is usually better than anything we could invent).
 */
export function explainSshFailure(stderr: string, hasAgent: boolean): string | null {
  if (/permission denied/i.test(stderr) && !hasAgent) {
    return (
      'No ssh agent is available to this app, so key authentication could not be attempted.\n\n' +
      'Start the app from a terminal where `ssh` works, or make the agent visible to your ' +
      'user session:\n  systemctl --user import-environment SSH_AUTH_SOCK'
    )
  }
  return null
}
