// Windows-only Node <-> Rust named-pipe proof. It starts an isolated Rust
// transport peer, exchanges an Amber protocol frame, then verifies that a
// queued write followed by Rust's forced close is observed by a live Node
// reader. Node/libuv exposes flowing-mode and close events, but no hook at the
// exact underlying ReadFile call; the Rust test covers that lower-level proof.
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
const sockets = new Set()
let peer

const once = (emitter, event) => new Promise((resolve, reject) => {
  emitter.once(event, resolve)
  emitter.once('error', reject)
})
const readExactly = (socket, length) => new Promise((resolve, reject) => {
  let received = Buffer.alloc(0)
  const onData = (chunk) => {
    received = Buffer.concat([received, chunk])
    if (received.length < length) return
    socket.off('error', onError)
    resolve(received)
  }
  const onError = (error) => reject(error)
  // Keep this data listener installed after resolution. That is the strongest
  // observable Node guarantee that the socket remains in flowing read mode;
  // libuv does not expose whether a kernel ReadFile is pending at an instant.
  socket.on('data', onData)
  socket.once('error', onError)
})
const connect = () => new Promise((resolve, reject) => {
  const socket = net.createConnection({ path: pipePath }, () => {
    sockets.add(socket)
    resolve(socket)
  })
  socket.once('error', reject)
})
const waitForLine = (child, line) => new Promise((resolve, reject) => {
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (output.split(/\r?\n/).includes(line)) resolve()
  })
  child.stderr.on('data', (chunk) => { errors += chunk })
  child.once('error', reject)
  child.once('exit', (code) => {
    if (!output.split(/\r?\n/).includes(line)) {
      reject(new Error(`Rust peer exited before ${line} (code ${code}): ${errors}`))
    }
  })
})
const within = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  promise.then(resolve, reject).finally(() => clearTimeout(timer))
})

try {
  await within((async () => {
    const cargo = process.env.CARGO ?? 'cargo'
    peer = spawn(cargo, [
      'run', '-q', '--manifest-path', 'crates/amber/tests/windows_pipe_peer/Cargo.toml', '--', endpoint,
    ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(peer, 'READY')

    const active = await connect()
    active.write(frame)
    const echoed = await readExactly(active, frame.length)
    assert.deepEqual(echoed, frame, 'Rust transport must preserve Amber frame bytes for Node')

    const stalled = await connect()
    const stalledClosed = once(stalled, 'close')
    const peerExited = once(peer, 'exit')
    const queuedRead = readExactly(stalled, Buffer.byteLength('queued-before-forced-close'))
    await waitForLine(peer, 'QUEUED')
    const queued = await queuedRead
    assert.deepEqual(queued, Buffer.from('queued-before-forced-close'))
    // Acknowledge that Node consumed the queued bytes while its persistent
    // data listener keeps the socket flowing. This does not claim a kernel
    // read is pending; Node exposes no such synchronization point.
    active.write(Buffer.from([1]))
    await waitForLine(peer, 'RELEASED')
    await stalledClosed
    const [exitCode] = await peerExited
    assert.equal(exitCode, 0, 'Rust peer must exit cleanly after forcing peer release')
  })(), 15_000)
  console.log('PASS Node<->Rust frame, multi-client acceptance, live-reader forced close')
} finally {
  for (const socket of sockets) socket.destroy()
  if (peer && peer.exitCode === null) {
    peer.kill()
    await within(once(peer, 'exit'), 2_000).catch(() => {})
  }
}
