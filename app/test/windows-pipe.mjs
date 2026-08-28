// Windows-only Node <-> Rust named-pipe proof. It starts an isolated Rust
// transport peer, exchanges an Amber protocol frame, then verifies that a
// queued write followed by Rust's forced close releases a stalled Node client.
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
    const echoed = await once(active, 'data')
    assert.deepEqual(echoed, frame, 'Rust transport must preserve Amber frame bytes for Node')

    const stalled = await connect()
    stalled.pause()
    const stalledClosed = once(stalled, 'close')
    const peerExited = once(peer, 'exit')
    await waitForLine(peer, 'RELEASED')
    await stalledClosed
    const [exitCode] = await peerExited
    assert.equal(exitCode, 0, 'Rust peer must exit cleanly after forcing peer release')
  })(), 15_000)
  console.log('PASS Node<->Rust frame, multi-client acceptance, queued-write forced release')
} finally {
  for (const socket of sockets) socket.destroy()
  if (peer && peer.exitCode === null) {
    peer.kill()
    await within(once(peer, 'exit'), 2_000).catch(() => {})
  }
}
