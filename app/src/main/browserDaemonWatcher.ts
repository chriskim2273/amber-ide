import type { Frame, SessionInfo } from '../shared/proto'
import type { ControllerSession } from './tabBrowserBroker'

export interface MetadataConnection {
  /** The epoch is the socket generation allocated by the production Connection. */
  on(event: 'frame', cb: (frame: Frame, epoch: number) => void): void
  on(event: 'open' | 'close', cb: (epoch: number) => void): void
  connect(): void
  send(frame: Frame): void
  close(): void
}

/** Process-owned, metadata-only daemon projection for browser authorization. */
export class BrowserDaemonWatcher {
  private readonly sessions = new Map<string, ControllerSession>()
  private connected = false
  private hasFullList = false
  private fullListAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly freshWaiters = new Set<(ready: boolean) => void>()
  private started = false
  private closed = false
  private activeEpoch = 0

  constructor(
    private readonly connection: MetadataConnection,
    private readonly now = Date.now,
    private readonly freshnessMs = 5_000,
    private readonly pollMs = 2_000,
  ) {
    connection.on('open', (epoch) => this.onOpen(epoch))
    connection.on('close', (epoch) => this.onClose(epoch))
    connection.on('frame', (frame, epoch) => this.onFrame(frame, epoch))
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true; this.connection.connect()
  }

  private onOpen(epoch: number): void {
    if (this.closed) return
    const nextEpoch = epoch
    if (nextEpoch < this.activeEpoch) return
    this.activeEpoch = nextEpoch
    this.connected = true; this.hasFullList = false; this.fullListAt = 0; this.sessions.clear()
    this.connection.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    this.connection.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
    if (this.timer) clearInterval(this.timer)
    const sourceEpoch = this.activeEpoch
    this.timer = setInterval(() => {
      if (!this.closed && this.connected && this.activeEpoch === sourceEpoch) this.connection.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
    }, this.pollMs)
  }

  private onClose(epoch: number): void {
    if (this.closed) return
    const sourceEpoch = epoch
    if (sourceEpoch < this.activeEpoch) return
    this.activeEpoch = sourceEpoch
    this.connected = false; this.hasFullList = false; this.fullListAt = 0; this.sessions.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private set(info: SessionInfo): void {
    this.sessions.set(info.name, {
      kind: info.kind, alive: info.alive,
      ...(typeof info.run_state === 'string' ? { runState: info.run_state } : {}),
    })
  }

  private onFrame(frame: Frame, epoch: number): void {
    if (this.closed || !this.connected || epoch !== this.activeEpoch || frame.type !== 'control') return
    if (frame.msg.kind === 'Sessions') {
      this.sessions.clear(); for (const info of frame.msg.sessions) this.set(info)
      this.hasFullList = true; this.fullListAt = this.now()
      for (const resolve of this.freshWaiters) resolve(true)
      this.freshWaiters.clear(); return
    }
    if (frame.msg.kind === 'SessionsChanged' && this.hasFullList) {
      for (const info of frame.msg.added) this.set(info)
      for (const name of frame.msg.removed) this.sessions.delete(name)
    }
  }

  waitForFresh(timeoutMs: number): Promise<boolean> {
    if (this.connected && this.hasFullList && this.now() - this.fullListAt <= this.freshnessMs) return Promise.resolve(true)
    if (!this.started || this.closed) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (ready: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); this.freshWaiters.delete(finish); resolve(ready) }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.freshWaiters.add(finish)
    })
  }

  controller(name: string): ControllerSession | undefined {
    if (this.closed || !this.connected || !this.hasFullList || this.now() - this.fullListAt > this.freshnessMs) return undefined
    return this.sessions.get(name)
  }

  close(): void {
    if (this.closed) return
    this.closed = true; this.connected = false; this.hasFullList = false; this.fullListAt = 0; this.sessions.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const resolve of this.freshWaiters) resolve(false)
    this.freshWaiters.clear(); this.connection.close()
  }
}
