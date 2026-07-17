import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode, Decoder, type Frame } from '../src/shared/proto'

let counter = 0

// In-memory unix-socket server speaking the real wire protocol. Test fixture
// for the utilityProcess connection/router without a real daemon.
export class FakeDaemon {
  private server = net.createServer()
  private clients = new Set<net.Socket>()
  readonly received: Frame[] = []
  private clientCb: ((send: (f: Frame) => void) => void) | null = null

  onClient(cb: (send: (f: Frame) => void) => void): void {
    this.clientCb = cb
  }

  listen(fixedPath?: string): Promise<string> {
    counter += 1
    const path = fixedPath ?? join(tmpdir(), `amber-fake-${process.pid}-${counter}.sock`)
    this.server.on('connection', (sock) => {
      this.clients.add(sock)
      const dec = new Decoder()
      sock.on('data', (chunk) => {
        dec.feed(new Uint8Array(chunk))
        for (let f = dec.next(); f; f = dec.next()) this.received.push(f)
      })
      sock.on('close', () => this.clients.delete(sock))
      sock.on('error', () => this.clients.delete(sock))
      this.clientCb?.((f) => sock.write(encode(f)))
    })
    return new Promise((res) => this.server.listen(path, () => res(path)))
  }

  push(frame: Frame): void {
    for (const c of this.clients) c.write(encode(frame))
  }

  // Write arbitrary (possibly malformed) bytes straight to every client — used
  // to exercise the decoder's error handling, which `push` (which always encodes
  // a valid frame) cannot reach.
  pushRaw(bytes: Uint8Array): void {
    for (const c of this.clients) c.write(bytes)
  }

  close(): Promise<void> {
    for (const c of this.clients) c.destroy()
    return new Promise((res) => this.server.close(() => res()))
  }
}
