import { AsyncLocalStorage } from 'node:async_hooks'

export type BrowserOperationKind = 'command' | 'broker' | 'association' | 'workspace-import' | 'recovery'
export type BrowserOperationSummary = Record<BrowserOperationKind, number> & { total: number }

interface ActiveOperation { kind: BrowserOperationKind; controller: AbortController }

interface LinkedSignal {
  signal: AbortSignal
  dispose: () => void
}

function linkSignals(inherited: AbortSignal, external?: AbortSignal): LinkedSignal {
  if (!external || external === inherited) return { signal: inherited, dispose: () => {} }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  inherited.addEventListener('abort', abort, { once: true })
  external.addEventListener('abort', abort, { once: true })
  if (inherited.aborted || external.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      inherited.removeEventListener('abort', abort)
      external.removeEventListener('abort', abort)
    },
  }
}

export class BrowserOperationRegistry {
  private readonly active = new Map<symbol, ActiveOperation>()
  private readonly context = new AsyncLocalStorage<AbortSignal | undefined>()
  private accepting = true
  private readonly emptyWaiters = new Set<() => void>()

  run<T>(kind: BrowserOperationKind, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const inherited = this.context.getStore()
    if (inherited) {
      const linked = linkSignals(inherited, external)
      try {
        this.assertDispatch(linked.signal)
        const result = this.context.run(linked.signal, () => work(linked.signal))
        return Promise.resolve(result).finally(linked.dispose)
      } catch (error) {
        linked.dispose()
        return Promise.reject(error)
      }
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
   * Start a top-level operation without inheriting an ambient operation from
   * the caller's promise continuation. Socket requests use this when their
   * per-connection FIFO callback happens to run in an older request's async
   * context; otherwise aborting that older request would cancel the new one.
   */
  runDetached<T>(kind: BrowserOperationKind, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    return this.context.run(undefined, () => this.run(kind, work, external))
  }

  /** Detached counterpart for a caller-owned request controller. */
  runWithControllerDetached<T>(kind: BrowserOperationKind, controller: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.context.run(undefined, () => this.runWithController(kind, controller, work))
  }

  /**
   * Run work with a controller owned by the caller. The controller is
   * registered before any asynchronous admission step so socket-close,
   * owner-cancel, and drain can abort it immediately.
   */
  runWithController<T>(kind: BrowserOperationKind, controller: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const inherited = this.context.getStore()
    if (inherited) {
      const linked = linkSignals(inherited, controller.signal)
      try {
        this.assertDispatch(linked.signal)
        const result = this.context.run(linked.signal, () => work(linked.signal))
        return Promise.resolve(result).finally(linked.dispose)
      } catch (error) {
        linked.dispose()
        return Promise.reject(error)
      }
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
