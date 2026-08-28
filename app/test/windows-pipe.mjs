// Windows-only named-pipe proof harness. It exercises Node's net client
// against a local `\\\\.\\pipe\\` listener, carries an Amber protocol frame over
// two independent connections, and then closes one intentionally stalled peer.
import assert from 'node:assert/strict'
import net from 'node:net'

if (process.platform !== 'win32') {
  console.log('SKIP windows-pipe.mjs: Windows named pipes require Windows')
  process.exit(0)
}

const path = `\\\\.\\pipe\\amber-node-pipe-${process.pid}-${Date.now()}`
const body = Buffer.from(JSON.stringify({ SessionList: { names: [] } }))
const frame = Buffer.concat([Buffer.from([0, 0, 0, body.length + 1, 0]), body])

const once = (emitter, event) => new Promise((resolve, reject) => {
  emitter.once(event, resolve)
  emitter.once('error', reject)
})
const connect = () => new Promise((resolve, reject) => {
  const socket = net.createConnection({ path }, () => resolve(socket))
  socket.once('error', reject)
})

const clients = []
const server = net.createServer((socket) => {
  clients.push(socket)
  if (clients.length === 1) {
    socket.once('data', (received) => socket.write(received))
  }
})
server.listen(path)
await once(server, 'listening')

const active = await connect()
const stalled = await connect()
active.write(frame)
const echoed = await once(active, 'data')
assert.deepEqual(echoed, frame, 'Node named-pipe connection must preserve Amber frame bytes')

stalled.pause()
const stalledClosed = once(stalled, 'close')
stalled.destroy()
await stalledClosed
active.destroy()
const serverClosed = once(server, 'close')
server.close()
await serverClosed
console.log('PASS Node named-pipe frame round-trip, second client, stalled-peer close')
