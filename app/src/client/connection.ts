import net from 'node:net'
import { encode, Decoder, type Frame } from '../shared/proto'

type FrameCb = (f: Frame) => void
type VoidCb = () => void

export class Connection {
  private socket: net.Socket | null = null
  private decoder = new Decoder()
  private frameCbs: FrameCb[] = []
  private openCbs: VoidCb[] = []
  private closeCbs: VoidCb[] = []
  private closed = false
  private attempt = 0

  constructor(private readonly path: string) {}

  on(event: 'frame', cb: FrameCb): void
  on(event: 'open', cb: VoidCb): void
  on(event: 'close', cb: VoidCb): void
  on(event: 'frame' | 'open' | 'close', cb: FrameCb | VoidCb): void {
    if (event === 'frame') this.frameCbs.push(cb as FrameCb)
    else if (event === 'open') this.openCbs.push(cb as VoidCb)
    else this.closeCbs.push(cb as VoidCb)
  }

  connect(): void {
    if (this.closed) return
    this.decoder = new Decoder()
    const socket = net.createConnection({ path: this.path })
    this.socket = socket
    socket.on('connect', () => { this.attempt = 0; for (const cb of this.openCbs) cb() })
    socket.on('data', (chunk: Buffer) => {
      this.decoder.feed(new Uint8Array(chunk))
      for (let f = this.decoder.next(); f; f = this.decoder.next()) for (const cb of this.frameCbs) cb(f)
    })
    socket.on('close', () => {
      for (const cb of this.closeCbs) cb()
      this.scheduleReconnect()
    })
    socket.on('error', () => { /* 'close' follows */ })
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = Math.min(2000, 100 * 2 ** this.attempt)
    this.attempt += 1
    setTimeout(() => this.connect(), delay)
  }

  send(frame: Frame): void { this.socket?.write(encode(frame)) }

  close(): void { this.closed = true; this.socket?.destroy(); this.socket = null }
}
