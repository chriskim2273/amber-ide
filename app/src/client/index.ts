import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import { Router, type PortLike } from './router'
import type { Frame } from '../shared/proto'

const conn = new Connection(resolveSocketPath(process.env))
const router = new Router(conn)
let controlPort: Electron.MessagePortMain | null = null

conn.on('frame', (f: Frame) => {
  if (f.type === 'control') controlPort?.postMessage({ frame: f })
})
conn.on('close', () => controlPort?.postMessage({ closed: true }))

process.parentPort.on('message', (event) => {
  const msg = event.data as { kind: 'control' } | { kind: 'pane'; session: string }
  const [port] = event.ports
  if (!port) return
  if (msg.kind === 'control') {
    controlPort = port
    port.start()
    conn.connect()
    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  } else {
    // MessagePortMain matches PortLike structurally (postMessage/on/start).
    router.attach(msg.session, port as unknown as PortLike)
  }
})
