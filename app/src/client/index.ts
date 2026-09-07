import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import { Router, type PortLike } from './router'
import { handleDaemonCommand, type DaemonCommand } from './commands'
import type { Frame } from '../shared/proto'

const conn = new Connection(resolveSocketPath(process.env))
const router = new Router(conn)
let controlPort: Electron.MessagePortMain | null = null

conn.on('frame', (f: Frame) => {
  // Pi semantic payloads have dedicated per-pane ports. Do not duplicate large
  // message/tool events onto the window-global control channel.
  if (f.type === 'control' && f.msg.kind !== 'PiEvent' && f.msg.kind !== 'PiBridgeStatus') {
    controlPort?.postMessage({ frame: f })
  }
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
    | { kind: 'suspend-panes' }
    | { kind: 'pi-pane'; session: string }
    | { kind: 'pi-pane-close'; session: string }
  // Lifecycle messages carry no port; hidden renderers release their views.
  if (msg.kind === 'pane-close') { router.detach(msg.session); return }
  if (msg.kind === 'pi-pane-close') { router.closePi(msg.session); return }
  if (msg.kind === 'suspend-panes') { router.detachAll(); return }
  const [port] = event.ports
  if (!port) return
  if (msg.kind === 'control') {
    controlPort = port
    port.on('message', (e) => {
      const cmd = e.data as DaemonCommand
      handleDaemonCommand(conn, cmd)
    })
    port.start()
    conn.connect()
  } else if (msg.kind === 'pi-pane') {
    router.attachPi(msg.session, port as unknown as PortLike)
  } else {
    // MessagePortMain matches PortLike structurally (postMessage/on/start).
    router.attach(msg.session, port as unknown as PortLike)
  }
})
