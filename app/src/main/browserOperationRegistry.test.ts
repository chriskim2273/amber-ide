import { describe, expect, it } from 'vitest'
import { BrowserOperationRegistry } from './browserOperationRegistry'

describe('BrowserOperationRegistry', () => {
  it('owns queued and immediate work, aborts all on drain, and waits until empty', async () => {
    const registry = new BrowserOperationRegistry()
    let queuedDispatch = false
    const immediate = registry.run('broker', async (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })))
    const queued = registry.run('association', async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      registry.assertDispatch(signal)
      queuedDispatch = true
    })
    expect(registry.summary()).toMatchObject({ broker: 1, association: 1, total: 2 })
    registry.beginDrain()
    await registry.waitForEmpty()
    await Promise.allSettled([immediate, queued])
    expect(queuedDispatch).toBe(false)
    expect(registry.summary().total).toBe(0)
    await expect(registry.run('command', async () => {})).rejects.toThrow('BROWSER_HOST_SHUTTING_DOWN')
  })

  it('uses one registry entry for nested service work', async () => {
    const registry = new BrowserOperationRegistry()
    await registry.run('broker', async () => {
      expect(registry.summary().total).toBe(1)
      await registry.run('command', async () => { expect(registry.summary().total).toBe(1) })
    })
  })

  it('can accept new work after a cancelled drain', async () => {
    const registry = new BrowserOperationRegistry()
    registry.beginDrain(); registry.cancelDrain()
    await expect(registry.run('workspace-import', async () => 7)).resolves.toBe(7)
  })
})
