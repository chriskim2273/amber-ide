import type { Frame, SessionInfo } from '../shared/proto'
import type { ControllerSession } from './tabBrowserBroker'

export interface MetadataConnection {
  on(event: 'frame', cb: (frame: Frame) => void): void
  on(event: 'open' | 'close', cb: () => void): void
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

  constructor(
    private readonly connection: MetadataConnection,
    private readonly now = Date.now,
    private readonly freshnessMs = 5_000,
    private readonly pollMs = 2_000,
  ) {
    connection.on('open', () => this.onOpen())
    connection.on('close', () => this.onClose())
    connection.on('frame', (frame) => this.onFrame(frame))
  }

  start(): void { this.connection.connect() }

  private onOpen(): void {
    this.connected = true; this.hasFullList = false; this.sessions.clear()
    this.connection.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    this.connection.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.connection.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } }), this.pollMs)
  }

  private onClose(): void {
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

  private onFrame(frame: Frame): void {
    if (frame.type !== 'control') return
    if (frame.msg.kind === 'Sessions') {
      this.sessions.clear(); for (const info of frame.msg.sessions) this.set(info)
      this.hasFullList = true; this.fullListAt = this.now(); return
    }
    if (frame.msg.kind === 'SessionsChanged' && this.hasFullList) {
      for (const info of frame.msg.added) this.set(info)
      for (const name of frame.msg.removed) this.sessions.delete(name)
    }
  }

  controller(name: string): ControllerSession | undefined {
    if (!this.connected || !this.hasFullList || this.now() - this.fullListAt > this.freshnessMs) return undefined
    return this.sessions.get(name)
  }

  close(): void { this.onClose(); this.connection.close() }
}
