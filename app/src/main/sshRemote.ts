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
