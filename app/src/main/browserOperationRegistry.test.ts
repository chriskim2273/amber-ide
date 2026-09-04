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

  it('links inherited and external cancellation through nested work', async () => {
    const registry = new BrowserOperationRegistry()
    const inherited = new AbortController(), external = new AbortController()
    let nestedSignal: AbortSignal | undefined
    let nestedStarted!: () => void
    const started = new Promise<void>((resolve) => { nestedStarted = resolve })
    const pending = registry.run('broker', async () => {
      await registry.run('command', async (signal) => {
        nestedSignal = signal; nestedStarted()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      }, external.signal)
    }, inherited.signal)
    await started
    expect(nestedSignal).not.toBe(inherited.signal)
    external.abort()
    await pending
    expect(nestedSignal?.aborted).toBe(true)
    expect(inherited.signal.aborted).toBe(false)
  })

  it('propagates linked cancellation to a deeper nested operation', async () => {
    const registry = new BrowserOperationRegistry()
    const outer = new AbortController(), middle = new AbortController()
    let deepest: AbortSignal | undefined
    const pending = registry.run('broker', async () => {
      await registry.run('command', async () => {
        await registry.run('recovery', async (signal) => {
          deepest = signal
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        }, middle.signal)
      }, middle.signal)
    }, outer.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    outer.abort()
    await pending
    expect(deepest?.aborted).toBe(true)
  })

  it('detaches a queued request from an older ambient cancellation owner', async () => {
    const registry = new BrowserOperationRegistry()
    const outer = new AbortController(); let innerSignal: AbortSignal | undefined; let release!: () => void
    const pending = registry.run('broker', async () => registry.runDetached('command', async (signal) => {
      innerSignal = signal
      await new Promise<void>((resolve) => { release = resolve })
      return 'done'
    }), outer.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    outer.abort()
    expect(innerSignal?.aborted).toBe(false)
    registry.beginDrain()
    expect(innerSignal?.aborted).toBe(true)
    release()
    await expect(pending).resolves.toBe('done')
  })

  it('can accept new work after a cancelled drain', async () => {
    const registry = new BrowserOperationRegistry()
    registry.beginDrain(); registry.cancelDrain()
    await expect(registry.run('workspace-import', async () => 7)).resolves.toBe(7)
  })
})
