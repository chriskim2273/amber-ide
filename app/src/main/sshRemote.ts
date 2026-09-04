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

import { EventEmitter } from 'node:events'
import { spawn as spawnProcess } from 'node:child_process'
import { join } from 'node:path'
import { LAYOUT_FILE_MAX_BYTES } from '../shared/layoutFile'

/** Where the remote daemon's socket is, per `resolveSocketPath`'s own rules. */
export const REMOTE_SOCKET_PROBE =
  'ls ${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/amber-ide/amberd.sock} ' +
  '"$HOME/.local/state/amber-ide/amberd.sock" 2>/dev/null | head -1'

/** Where the remote layout sidecar is. Same derivation, different file. */
export const REMOTE_LAYOUT_PROBE =
  'cat ${XDG_STATE_HOME:-$HOME/.local/state}/amber-ide/ui-layout.json 2>/dev/null'

/** The remote sidecar and the local CAS share one ingress byte contract. */
export const REMOTE_LAYOUT_PROBE_MAX_BYTES = LAYOUT_FILE_MAX_BYTES
export const SSH_PROBE_TIMEOUT_MS = 15_000
const SSH_PROBE_DEFAULT_MAX_BYTES = 64 * 1024

export interface Argv {
  cmd: string
  args: string[]
}

export type SshProbeStream = EventEmitter
export interface SshProbeChild {
  stdout: SshProbeStream
  stderr: SshProbeStream
  on(event: string, listener: (...args: unknown[]) => void): this
  once(event: string, listener: (...args: unknown[]) => void): this
  removeListener(event: string, listener: (...args: unknown[]) => void): this
  kill(signal?: NodeJS.Signals): boolean
}
export interface SshProbeSpawnOptions {
  stdio: ['ignore', 'pipe', 'pipe']
  env: NodeJS.ProcessEnv
}
export interface SshProbeDeps {
  spawn: (cmd: string, args: string[], options: SshProbeSpawnOptions) => SshProbeChild
}
export interface SshProbeOptions {
  maxBytes?: number
  timeoutMs?: number
}
export interface SshProbeResult {
  out: string
  err: string
  code: number
  error?: 'LAYOUT_FILE_LIMIT' | 'SSH_PROBE_TIMEOUT' | 'SSH_PROBE_FAILED'
}

const defaultSshProbeDeps: SshProbeDeps = {
  spawn: (cmd, args, options) => spawnProcess(cmd, args, options) as unknown as SshProbeChild,
}

function boundedErrorText(error: unknown, maxBytes: number): string {
  const text = error instanceof Error ? error.message : String(error)
  const bytes = Buffer.from(text)
  return bytes.byteLength <= maxBytes ? text : bytes.subarray(0, maxBytes).toString('utf8')
}

/**
 * Collect one ssh child's output under a byte and wall-clock bound.
 *
 * Overflow/timeout resolves immediately after sending SIGKILL to THIS child;
 * it does not wait for a non-cooperative child to emit `close`. The result
 * carries no partial stdout, so callers cannot accidentally treat a truncated
 * layout as a valid sidecar.
 */
export function collectSshProbe(child: SshProbeChild, options: SshProbeOptions = {}): Promise<SshProbeResult> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? SSH_PROBE_DEFAULT_MAX_BYTES))
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? SSH_PROBE_TIMEOUT_MS))
  return new Promise((resolve) => {
    let outBytes = 0
    let errBytes = 0
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
    }
    const finish = (result: SshProbeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const abort = (error: SshProbeResult['error']): void => {
      // Settle and remove listeners before kill: a fake or already-failing
      // ChildProcess may emit `error` synchronously from kill(), and that must
      // not overwrite the deterministic limit/timeout classification.
      finish({ out: '', err: '', code: -1, ...(error ? { error } : {}) })
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    const accept = (target: Buffer[], current: 'out' | 'err', chunk: unknown): void => {
      if (settled) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const nextTotal = outBytes + errBytes + bytes.byteLength
      if (nextTotal > maxBytes) {
        abort('LAYOUT_FILE_LIMIT')
        return
      }
      target.push(bytes)
      if (current === 'out') outBytes += bytes.byteLength
      else errBytes += bytes.byteLength
    }
    function onStdout(chunk: unknown): void { accept(out, 'out', chunk) }
    function onStderr(chunk: unknown): void { accept(err, 'err', chunk) }
    function onClose(code: unknown): void {
      const exitCode = typeof code === 'number' ? code : -1
      finish({ out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), code: exitCode })
    }
    function onError(error: unknown): void {
      finish({ out: '', err: boundedErrorText(error, maxBytes), code: -1, error: 'SSH_PROBE_FAILED' })
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('close', onClose)
    child.once('error', onError)
    timer = setTimeout(() => abort('SSH_PROBE_TIMEOUT'), timeoutMs)
    timer.unref()
  })
}

/** Spawn and collect a bounded one-shot remote probe. */
export function runSshProbe(
  host: string,
  script: string,
  env: NodeJS.ProcessEnv,
  options: SshProbeOptions = {},
  deps: SshProbeDeps = defaultSshProbeDeps,
): Promise<SshProbeResult> {
  const argv = sshProbeArgv(host, script)
  try {
    const child = deps.spawn(argv.cmd, argv.args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    return collectSshProbe(child, options)
  } catch (error) {
    return Promise.resolve({ out: '', err: boundedErrorText(error, options.maxBytes ?? SSH_PROBE_DEFAULT_MAX_BYTES), code: -1, error: 'SSH_PROBE_FAILED' })
  }
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
