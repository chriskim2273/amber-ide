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
let peerLines

const once = (emitter, event) => new Promise((resolve, reject) => {
  const cleanup = () => {
    emitter.off(event, onEvent)
    emitter.off('error', onError)
  }
  const onEvent = (...args) => {
    cleanup()
    resolve(args)
  }
  const onError = (error) => {
    cleanup()
    reject(error)
  }
  emitter.once(event, onEvent)
  emitter.once('error', onError)
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
const monitorLines = (child) => {
  let output = ''
  let errors = ''
  let ended
  const lines = []
  const waiters = new Map()

  const deliver = (line) => {
    const waiting = waiters.get(line)
    if (waiting?.length) {
      waiting.shift().resolve()
      if (waiting.length === 0) waiters.delete(line)
    } else {
      lines.push(line)
    }
  }
  const onStdout = (chunk) => {
    output += chunk
    const complete = output.split(/\r?\n/)
    output = complete.pop() ?? ''
    for (const line of complete) deliver(line)
  }
  const onStderr = (chunk) => { errors += chunk }
  const rejectWaiters = (error) => {
    for (const waiting of waiters.values()) {
      for (const waiter of waiting) waiter.reject(error)
    }
    waiters.clear()
  }
  const onError = (error) => {
    ended = error
    rejectWaiters(error)
  }
  const onExit = (code, signal) => {
    if (output) {
      deliver(output)
      output = ''
    }
    ended = new Error(`Rust peer exited (code ${code}, signal ${signal}): ${errors}`)
    rejectWaiters(ended)
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', onStdout)
  child.stderr.on('data', onStderr)
  child.on('error', onError)
  child.on('exit', onExit)

  return {
    waitFor(line) {
      const queued = lines.indexOf(line)
      if (queued !== -1) {
        lines.splice(queued, 1)
        return Promise.resolve()
      }
      if (ended) return Promise.reject(ended)
      return new Promise((resolve, reject) => {
        const waiting = waiters.get(line) ?? []
        waiting.push({ resolve, reject })
        waiters.set(line, waiting)
      })
    },
    dispose() {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      rejectWaiters(new Error('Rust peer line monitor disposed'))
    }
  }
}
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
    peerLines = monitorLines(peer)
    await peerLines.waitFor('READY')

    const active = await connect()
    active.write(frame)
    const echoed = await readExactly(active, frame.length)
    assert.deepEqual(echoed, frame, 'Rust transport must preserve Amber frame bytes for Node')

    const stalled = await connect()
    const stalledClosed = once(stalled, 'close')
    const peerExited = once(peer, 'exit')
    const queuedRead = readExactly(stalled, Buffer.byteLength('queued-before-forced-close'))
    await peerLines.waitFor('QUEUED')
    const queued = await queuedRead
    assert.deepEqual(queued, Buffer.from('queued-before-forced-close'))
    // Acknowledge that Node consumed the queued bytes while its persistent
    // data listener keeps the socket flowing. This does not claim a kernel
    // read is pending; Node exposes no such synchronization point.
    active.write(Buffer.from([1]))
    await peerLines.waitFor('RELEASED')
    await stalledClosed
    const [exitCode] = await peerExited
    assert.equal(exitCode, 0, 'Rust peer must exit cleanly after forcing peer release')
  })(), 15_000)
  console.log('PASS Node<->Rust frame, multi-client acceptance, live-reader forced close')
} finally {
  for (const socket of sockets) socket.destroy()
  if (peer && peer.exitCode === null) {
    const peerExited = once(peer, 'exit')
    peer.kill()
    await within(peerExited, 2_000).catch(() => {})
  }
  peerLines?.dispose()
}
