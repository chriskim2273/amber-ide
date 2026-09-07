import { expect, it, vi } from 'vitest'
import { BrowserAgentCursor } from './browserAgentCursor'
it('does not restore an old cursor when revocation races screenshot suspension', async () => {
  vi.useFakeTimers()
  let finishHide!: () => void, first = true
  const highlights: unknown[] = []
  const cursor = new BrowserAgentCursor({ isAttached: () => true, send: async (method, params) => {
    if (method === 'Overlay.hideHighlight' && first) { first = false; await new Promise<void>(resolve => { finishHide = resolve }) }
    if (method === 'Overlay.highlightQuad') highlights.push(params)
    return {}
  } })
  try {
    cursor.show({ x: 10, y: 20 })
    const suspended = cursor.suspend()
    await cursor.hide()
    finishHide()
    const restore = await suspended
    restore()
    await vi.runAllTimersAsync()
    expect(highlights).toHaveLength(0)
  } finally { cursor.dispose(); vi.useRealTimers() }
})
it('cancels pending highlights when hidden and does not retain a late cursor', async () => {
  vi.useFakeTimers()
  const calls: string[] = []
  const transport = { isAttached: () => true, send: async (method: string) => { calls.push(method); return {} } }
  const cursor = new BrowserAgentCursor(transport)
  cursor.show({ x: 10, y: 20 }); await cursor.hide()
  await vi.runAllTimersAsync()
  expect(calls).not.toContain('Overlay.highlightQuad')
  expect(calls).toContain('Overlay.hideHighlight')
  cursor.dispose(); vi.useRealTimers()
})
it('coalesces rapid moves into a single latest-point marker', async () => {
  vi.useFakeTimers()
  const points: unknown[] = []
  const cursor = new BrowserAgentCursor({ isAttached: () => true, send: async (method, params) => { if (method === 'Overlay.highlightQuad') points.push(params?.quad); return {} } })
  cursor.show({ x: 10, y: 20 }); cursor.show({ x: 30, y: 40 })
  await vi.runAllTimersAsync()
  expect(points).toHaveLength(1)
  expect(points[0]).toEqual([30, 40, 40, 44, 34, 50, 30, 40])
  cursor.dispose(); vi.useRealTimers()
})
