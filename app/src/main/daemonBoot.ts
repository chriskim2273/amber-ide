import net from 'node:net'

export function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ path })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
  })
}

/** Only ENOENT proves that a local socket/named-pipe endpoint is absent. */
export function isSocketAbsentError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT'
}

/**
 * Distinguish an absent local endpoint from every other connection failure.
 * In particular, access denied, a wedged daemon, and a bad transport must not
 * be treated as permission to kill the process that owns session state.
 */
export function isSocketAbsent(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ path })
    sock.once('connect', () => { sock.destroy(); resolve(false) })
    sock.once('error', (error: NodeJS.ErrnoException) => resolve(isSocketAbsentError(error)))
  })
}

export interface EnsureDeps {
  /** Runs before the health probe; packaged upgrades use this to refresh binaries. */
  preflight?: () => Promise<void>
  probe: (path: string) => Promise<boolean>
  install: () => Promise<void>
  delayMs: (attempt: number) => number
  attempts: number
}

export async function ensureDaemon(path: string, deps: EnsureDeps): Promise<void> {
  await deps.preflight?.()
  if (await deps.probe(path)) return
  await deps.install()
  for (let attempt = 0; attempt < deps.attempts; attempt++) {
    await new Promise((r) => setTimeout(r, deps.delayMs(attempt)))
    if (await deps.probe(path)) return
  }
  throw new Error(`amber daemon did not come up at ${path}`)
}
