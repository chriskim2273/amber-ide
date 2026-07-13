import net from 'node:net'
import { encode, Decoder, type Frame } from '../shared/proto'

type FrameCb = (f: Frame) => void
type CloseCb = () => void

export class Connection {
  private socket: net.Socket | null = null
  private readonly decoder = new Decoder()
  private frameCbs: FrameCb[] = []
  private closeCbs: CloseCb[] = []

  constructor(private readonly path: string) {}

  on(event: 'frame', cb: FrameCb): void
  on(event: 'close', cb: CloseCb): void
  on(event: 'frame' | 'close', cb: FrameCb | CloseCb): void {
    if (event === 'frame') this.frameCbs.push(cb as FrameCb)
    else this.closeCbs.push(cb as CloseCb)
  }

  connect(): void {
    const socket = net.createConnection({ path: this.path })
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.decoder.feed(new Uint8Array(chunk))
      for (let f = this.decoder.next(); f; f = this.decoder.next()) {
        for (const cb of this.frameCbs) cb(f)
      }
    })
    socket.on('close', () => { for (const cb of this.closeCbs) cb() })
    socket.on('error', () => { /* 'close' follows */ })
  }

  send(frame: Frame): void {
    this.socket?.write(encode(frame))
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }
}
