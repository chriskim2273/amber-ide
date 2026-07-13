import { describe, it, expect, afterEach } from 'vitest'
import { FakeDaemon } from '../../test/fakeDaemon'
import { Connection } from './connection'
import type { Frame } from '../shared/proto'

let daemon: FakeDaemon | null = null
afterEach(async () => { await daemon?.close(); daemon = null })

function waitFor<T>(fn: () => T | null, ms = 2000): Promise<T> {
  return new Promise((res, rej) => {
    const started = Date.now()
    const tick = () => {
      const v = fn()
      if (v != null) return res(v)
      if (Date.now() - started > ms) return rej(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('Connection', () => {
  it('receives decoded frames and sends encoded frames', async () => {
    daemon = new FakeDaemon()
    daemon.onClient((send) => {
      send({ type: 'control', msg: { kind: 'Sessions', sessions: [] } })
    })
    const path = await daemon.listen()

    const frames: Frame[] = []
    const conn = new Connection(path)
    conn.on('frame', (f) => frames.push(f))
    conn.connect()

    const first = await waitFor(() => frames[0] ?? null)
    expect(first).toEqual({ type: 'control', msg: { kind: 'Sessions', sessions: [] } })

    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    await waitFor(() => daemon!.received.find((f) => f.type === 'control' && f.msg.kind === 'WatchSessions') ?? null)

    conn.close()
  })

  it('fires close when the daemon goes away', async () => {
    daemon = new FakeDaemon()
    const path = await daemon.listen()
    let closed = false
    const conn = new Connection(path)
    conn.on('close', () => { closed = true })
    conn.connect()
    await new Promise((r) => setTimeout(r, 50))
    await daemon.close()
    await waitFor(() => (closed ? true : null))
    expect(closed).toBe(true)
  })

  it('reconnects and re-opens after the daemon drops and returns', async () => {
    daemon = new FakeDaemon()
    const path = await daemon.listen()
    let opens = 0
    const conn = new Connection(path)
    conn.on('open', () => { opens += 1 })
    conn.connect()
    await waitFor(() => (opens >= 1 ? true : null))
    await daemon.close()                 // daemon drops
    daemon = new FakeDaemon()
    await daemon.listen(path)             // returns on the same socket path
    await waitFor(() => (opens >= 2 ? true : null), 5000)
    expect(opens).toBeGreaterThanOrEqual(2)
    conn.close()
  })
})
