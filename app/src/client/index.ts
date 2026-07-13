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
    port.on('message', (e) => {
      const cmd = e.data as
        | { cmd: 'create'; name: string; cwd: string; sessionKind: string }
        | { cmd: 'kill'; name: string }
      if (cmd.cmd === 'create') {
        conn.send({ type: 'control', msg: { kind: 'Create', name: cmd.name, cwd: cmd.cwd, sessionKind: cmd.sessionKind } })
      } else if (cmd.cmd === 'kill') {
        conn.send({ type: 'control', msg: { kind: 'Kill', name: cmd.name } })
      }
    })
    port.start()
    conn.connect()
    conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
    conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  } else {
    // MessagePortMain matches PortLike structurally (postMessage/on/start).
    router.attach(msg.session, port as unknown as PortLike)
  }
})
