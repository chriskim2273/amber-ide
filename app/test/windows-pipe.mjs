// Windows-only Node <-> Rust named-pipe proof. It starts the test-only Rust
// peer, exchanges one Amber protocol frame, connects a second stalled client,
// and requires the Rust server to release that peer.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import path from 'node:path'

if (process.platform !== 'win32') {
  console.log('SKIP windows-pipe.mjs: Windows named pipes require Windows')
  process.exit(0)
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const endpoint = `amber-node-rust-pipe-${process.pid}-${Date.now()}`
const pipePath = `\\\\.\\pipe\\${endpoint}`
const body = Buffer.from(JSON.stringify({ SessionList: { names: [] } }))
const frame = Buffer.concat([Buffer.from([0, 0, 0, body.length + 1, 0]), body])

const once = (emitter, event) => new Promise((resolve, reject) => {
  emitter.once(event, resolve)
  emitter.once('error', reject)
})
const connect = () => new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: pipePath }, () => resolve(socket))
  socket.once('error', reject)
})
const waitForLine = (child, line) => new Promise((resolve, reject) => {
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (output.split(/\r?\n/).includes(line)) resolve()
  })
  child.once('error', reject)
  child.once('exit', (code) => {
    if (!output.split(/\r?\n/).includes(line)) {
      reject(new Error(`Rust peer exited before ${line} (code ${code})`))
    }
  })
})

const cargo = process.env.CARGO ?? 'cargo'
const peer = spawn(cargo, [
  'run', '-q', '-p', 'amber', '--features', 'windows-pipe-harness',
  '--bin', 'amber-windows-pipe-peer', '--', endpoint,
], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
await waitForLine(peer, 'READY')

const active = await connect()
active.write(frame)
const echoed = await once(active, 'data')
assert.deepEqual(echoed, frame, 'Rust transport must preserve Amber frame bytes for Node')

const stalled = await connect()
stalled.pause()
const stalledClosed = once(stalled, 'close')
const peerExited = once(peer, 'exit')
await waitForLine(peer, 'RELEASED')
await stalledClosed
active.destroy()

const [exitCode] = await peerExited
assert.equal(exitCode, 0, 'Rust peer must exit cleanly after releasing the second Node client')
console.log('PASS Node<->Rust frame, multi-client acceptance, stalled-peer release')
