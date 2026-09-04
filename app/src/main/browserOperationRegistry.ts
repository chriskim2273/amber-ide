import { AsyncLocalStorage } from 'node:async_hooks'

export type BrowserOperationKind = 'command' | 'broker' | 'association' | 'workspace-import' | 'recovery'
export type BrowserOperationSummary = Record<BrowserOperationKind, number> & { total: number }

interface ActiveOperation { kind: BrowserOperationKind; controller: AbortController }

export class BrowserOperationRegistry {
  private readonly active = new Map<symbol, ActiveOperation>()
  private readonly context = new AsyncLocalStorage<AbortSignal>()
  private accepting = true
  private readonly emptyWaiters = new Set<() => void>()

  run<T>(kind: BrowserOperationKind, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const inherited = this.context.getStore()
    if (inherited) {
      this.assertDispatch(inherited)
      if (external?.aborted) return Promise.reject(new Error('ACTION_CANCELLED'))
      return work(inherited)
    }
    if (!this.accepting) return Promise.reject(new Error('BROWSER_HOST_SHUTTING_DOWN'))
    const key = Symbol(kind), controller = new AbortController()
    const abort = (): void => controller.abort()
    external?.addEventListener('abort', abort, { once: true })
    if (external?.aborted) controller.abort()
    this.active.set(key, { kind, controller })
    return this.context.run(controller.signal, async () => {
      try {
        this.assertDispatch(controller.signal)
        return await work(controller.signal)
      } finally {
        external?.removeEventListener('abort', abort)
        this.finish(key)
      }
    })
  }

  /**
   * Run work with a controller owned by the caller. This is needed when a
   * request has an asynchronous admission step before it can be put on its
   * resource FIFO: the controller must already be visible to socket-close,
   * owner-cancel, and drain before that step is awaited.
   */
  runWithController<T>(kind: BrowserOperationKind, controller: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const inherited = this.context.getStore()
    if (inherited) {
      this.assertDispatch(inherited)
      if (controller.signal.aborted) return Promise.reject(new Error('ACTION_CANCELLED'))
      return work(inherited)
    }
    if (!this.accepting) {
      controller.abort()
      return Promise.reject(new Error('BROWSER_HOST_SHUTTING_DOWN'))
    }
    const key = Symbol(kind)
    this.active.set(key, { kind, controller })
    return this.context.run(controller.signal, async () => {
      try {
        this.assertDispatch(controller.signal)
        return await work(controller.signal)
      } finally {
        this.finish(key)
      }
    })
  }

  private finish(key: symbol): void {
    this.active.delete(key)
    if (this.active.size === 0) {
      for (const resolve of this.emptyWaiters) resolve()
      this.emptyWaiters.clear()
    }
  }

  assertDispatch(signal?: AbortSignal): void {
    if (!this.accepting) throw new Error('BROWSER_HOST_SHUTTING_DOWN')
    if (signal?.aborted) throw new Error('ACTION_CANCELLED')
  }

  beginDrain(): void {
    this.accepting = false
    for (const operation of this.active.values()) operation.controller.abort()
  }

  cancelDrain(): void { this.accepting = true }

  waitForEmpty(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.emptyWaiters.add(resolve))
  }

  summary(): BrowserOperationSummary {
    const result: BrowserOperationSummary = { command: 0, broker: 0, association: 0, 'workspace-import': 0, recovery: 0, total: 0 }
    for (const operation of this.active.values()) { result[operation.kind] += 1; result.total += 1 }
    return result
  }
}
