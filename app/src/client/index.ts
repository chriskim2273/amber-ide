import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import { Router, type PortLike } from './router'
import type { Frame } from '../shared/proto'

const conn = new Connection(resolveSocketPath(process.env))
const router = new Router(conn)
let controlPort: Electron.MessagePortMain | null = null

conn.on('frame', (f: Frame) => {
  if (f.type === 'control') controlPort?.postMessage({ frame: f })
  // A scrollback dump now arrives on its own BINARY tag (no JSON numeric array
  // on the wire), but the renderer's dump-correlation path is unchanged: hand it
  // over in the shape it already matches on. This hop is a MessagePort, so the
  // bytes ride structured clone — no serialisation either way.
  else if (f.type === 'backlog') {
    controlPort?.postMessage({ frame: { type: 'control', msg: { kind: 'Backlog', name: f.session, data: f.bytes } } })
  }
})
conn.on('open', () => {
  controlPort?.postMessage({ status: 'connected' })
  conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
  conn.send({ type: 'control', msg: { kind: 'WatchMemoryPressure', version: 2 } })
  conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
  router.reattachAll()
})
conn.on('close', () => controlPort?.postMessage({ status: 'disconnected' }))

process.parentPort.on('message', (event) => {
  const msg = event.data as
    | { kind: 'control' }
    | { kind: 'pane'; session: string }
    | { kind: 'pane-close'; session: string }
  // A pane going away carries no port — it releases the one we already hold.
  if (msg.kind === 'pane-close') { router.detach(msg.session); return }
  const [port] = event.ports
  if (!port) return
  if (msg.kind === 'control') {
    controlPort = port
    port.on('message', (e) => {
      const cmd = e.data as
        | { cmd: 'create'; name: string; cwd: string; sessionKind: string }
        | { cmd: 'kill'; name: string }
        | { cmd: 'rename'; from: string; to: string }
        | { cmd: 'dumpBacklog'; name: string }
        | { cmd: 'searchScrollback'; requestId: number; query: string; names: string[]; limit: number }
        | { cmd: 'listRecoveryEvents'; limit: number }
        | { cmd: 'clearRecoveryEvents' }
        | { cmd: 'suspend'; name: string }
        | { cmd: 'resume'; name: string }
        | { cmd: 'focus'; name: string }
        | { cmd: 'getMemoryBudget' }
        | { cmd: 'setMemoryBudget'; mb: number }
        | { cmd: 'snapshot' }
      if (cmd.cmd === 'create') {
        conn.send({ type: 'control', msg: { kind: 'Create', name: cmd.name, cwd: cmd.cwd, sessionKind: cmd.sessionKind } })
      } else if (cmd.cmd === 'kill') {
        conn.send({ type: 'control', msg: { kind: 'Kill', name: cmd.name } })
      } else if (cmd.cmd === 'rename') {
        conn.send({ type: 'control', msg: { kind: 'Rename', from: cmd.from, to: cmd.to } })
      } else if (cmd.cmd === 'dumpBacklog') {
        conn.send({ type: 'control', msg: { kind: 'DumpBacklog', name: cmd.name } })
      } else if (cmd.cmd === 'searchScrollback') {
        conn.send({
          type: 'control',
          msg: {
            kind: 'SearchScrollback', request_id: cmd.requestId,
            query: cmd.query, names: cmd.names, limit: cmd.limit,
          },
        })
      } else if (cmd.cmd === 'listRecoveryEvents') {
        conn.send({ type: 'control', msg: { kind: 'ListRecoveryEvents', limit: cmd.limit } })
      } else if (cmd.cmd === 'clearRecoveryEvents') {
        conn.send({ type: 'control', msg: { kind: 'ClearRecoveryEvents' } })
      } else if (cmd.cmd === 'suspend') {
        conn.send({ type: 'control', msg: { kind: 'Suspend', name: cmd.name } })
      } else if (cmd.cmd === 'resume') {
        conn.send({ type: 'control', msg: { kind: 'Resume', name: cmd.name } })
      } else if (cmd.cmd === 'focus') {
        conn.send({ type: 'control', msg: { kind: 'Focus', name: cmd.name } })
      } else if (cmd.cmd === 'getMemoryBudget') {
        conn.send({ type: 'control', msg: { kind: 'GetMemoryBudget' } })
      } else if (cmd.cmd === 'setMemoryBudget') {
        conn.send({ type: 'control', msg: { kind: 'SetMemoryBudget', mb: cmd.mb } })
      } else if (cmd.cmd === 'snapshot') {
        conn.send({ type: 'control', msg: { kind: 'Snapshot' } })
      }
    })
    port.start()
    conn.connect()
  } else {
    // MessagePortMain matches PortLike structurally (postMessage/on/start).
    router.attach(msg.session, port as unknown as PortLike)
  }
})
