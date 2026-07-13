import net from 'node:net'

export function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ path })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
  })
}

export interface EnsureDeps {
  probe: (path: string) => Promise<boolean>
  install: () => Promise<void>
  delayMs: (attempt: number) => number
  attempts: number
}

export async function ensureDaemon(path: string, deps: EnsureDeps): Promise<void> {
  if (await deps.probe(path)) return
  await deps.install()
  for (let attempt = 0; attempt < deps.attempts; attempt++) {
    await new Promise((r) => setTimeout(r, deps.delayMs(attempt)))
    if (await deps.probe(path)) return
  }
  throw new Error(`amber daemon did not come up at ${path}`)
}
