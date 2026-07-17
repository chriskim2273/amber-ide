import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { collectDumps } from './dumps'

// A fake resolver registry mirroring the renderer's dumpResolvers map.
function harness() {
  const cbs = new Map<string, (d: Uint8Array) => void>()
  const requested: string[] = []
  return {
    request: (name: string) => { requested.push(name) },
    register: (name: string, cb: (d: Uint8Array) => void) => { cbs.set(name, cb) },
    unregister: (name: string) => { cbs.delete(name) },
    // Simulate a daemon Backlog reply arriving for `name`.
    reply: (name: string, data: Uint8Array) => cbs.get(name)?.(data),
    cbs,
    requested,
  }
}

describe('collectDumps', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('empty names resolves immediately, empty result', async () => {
    const h = harness()
    await expect(collectDumps([], h.request, h.register, h.unregister)).resolves.toEqual({ dumps: {}, stragglers: [] })
    expect(h.requested).toEqual([])
  })

  it('resolves as soon as every reply lands (before timeout)', async () => {
    const h = harness()
    const p = collectDumps(['a', 'b'], h.request, h.register, h.unregister, 5000)
    expect(h.requested).toEqual(['a', 'b'])
    h.reply('a', new Uint8Array([1]))
    h.reply('b', new Uint8Array([2, 3]))
    const r = await p
    expect(r.stragglers).toEqual([])
    expect([...r.dumps['a']!]).toEqual([1])
    expect([...r.dumps['b']!]).toEqual([2, 3])
  })

  it('times out with stragglers; late reply ignored, resolver cleaned up', async () => {
    const h = harness()
    const p = collectDumps(['a', 'b'], h.request, h.register, h.unregister, 5000)
    h.reply('a', new Uint8Array([9]))
    vi.advanceTimersByTime(5000)
    const r = await p
    expect(r.stragglers).toEqual(['b'])
    expect([...r.dumps['a']!]).toEqual([9])
    // Straggler resolver was unregistered on timeout.
    expect(h.cbs.has('b')).toBe(false)
    // A late reply for 'b' is a no-op (does not mutate the already-resolved result).
    h.reply('b', new Uint8Array([7]))
    expect(r.dumps['b']).toBeUndefined()
  })
})
