import { resolveSocketPath } from '../shared/socketPath'
import { Connection } from './connection'
import type { Frame } from '../shared/proto'

// The utility process receives one control MessagePortMain from main.
process.parentPort.on('message', (event) => {
  const [controlPort] = event.ports
  if (!controlPort) return
  controlPort.start()

  const conn = new Connection(resolveSocketPath(process.env))
  conn.on('frame', (f: Frame) => {
    if (f.type === 'control') controlPort.postMessage({ frame: f })
  })
  conn.on('close', () => controlPort.postMessage({ closed: true }))
  conn.connect()
  conn.send({ type: 'control', msg: { kind: 'WatchSessions' } })
  conn.send({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
})
