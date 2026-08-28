// Windows-only Node <-> Rust named-pipe proof. It starts an isolated Rust
// transport peer, exchanges an Amber protocol frame, then verifies that a
// queued write followed by Rust's forced close is observed by a live Node
// reader. Node/libuv exposes flowing-mode and close events, but no hook at the
// exact underlying ReadFile call; the Rust test covers that lower-level proof.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once as onceEvent } from 'node:events'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import path from 'node:path'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const endpoint = `amber-node-rust-pipe-${process.pid}-${Date.now()}`
const pipePath = `\\\\.\\pipe\\${endpoint}`
const body = Buffer.from(JSON.stringify({ SessionList: { names: [] } }))
const frame = Buffer.concat([Buffer.from([0, 0, 0, body.length + 1, 0]), body])
const sockets = new Set()
let peer
let peerLines
let build

const peerDirectory = (repoRoot) => path.join(
  repoRoot,
  'crates', 'amber', 'tests', 'windows_pipe_peer',
)
export const peerBuildInvocation = ({
  repoRoot = repo,
  cargo = process.env.CARGO ?? 'cargo',
} = {}) => ({
  command: cargo,
  args: [
    'build', '-q', '--manifest-path', path.join(peerDirectory(repoRoot), 'Cargo.toml'),
    '--target-dir', path.join(peerDirectory(repoRoot), 'target'),
  ],
})
export const peerRunInvocation = ({
  repoRoot = repo,
  platform = process.platform,
  endpoint: targetEndpoint = endpoint,
} = {}) => ({
  command: path.join(
    peerDirectory(repoRoot),
    'target', 'debug', `windows_pipe_peer${platform === 'win32' ? '.exe' : ''}`,
  ),
  args: [targetEndpoint],
})

const abortReason = (signal) => (
  signal.reason instanceof Error ? signal.reason : new Error('operation aborted')
)
export const stageWait = (promise) => {
  // Attach both settlement handlers now. A later deadline may abort this wait
  // before control reaches its await site; the staged promise itself therefore
  // always fulfills and cannot become an unhandled rejection.
  const settlement = Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  )
  return async () => {
    const result = await settlement
    if (result.status === 'rejected') throw result.reason
    return result.value
  }
}
const trackSocket = (socket) => {
  sockets.add(socket)
  const onError = () => {}
  const onClose = () => {
    socket.off('error', onError)
    sockets.delete(socket)
  }
  // A cleanup-induced connection error must not become an uncaught event.
  // Operation-specific waits install their own error listener as well.
  socket.on('error', onError)
  socket.once('close', onClose)
  return socket
}
export const readExactly = (socket, length, signal) => new Promise((resolve, reject) => {
  let received = Buffer.alloc(0)
  let settled = false
  const stopWaiting = () => {
    socket.off('error', onError)
    signal.removeEventListener('abort', onAbort)
  }
  const stopReading = () => {
    stopWaiting()
    socket.off('data', onData)
    socket.off('close', onClose)
  }
  const onData = (chunk) => {
    if (settled) return
    received = Buffer.concat([received, chunk])
    if (received.length < length) return
    settled = true
    stopWaiting()
    resolve(received)
  }
  const onError = (error) => {
    if (settled) return
    settled = true
    stopReading()
    reject(error)
  }
  const onClose = () => {
    stopReading()
    if (settled) return
    settled = true
    reject(new Error(`socket closed after ${received.length} of ${length} bytes`))
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    stopReading()
    socket.destroy()
    reject(abortReason(signal))
  }
  // Keep this data listener installed after resolution. That is the strongest
  // observable Node guarantee that the socket remains in flowing read mode;
  // libuv does not expose whether a kernel ReadFile is pending at an instant.
  socket.on('data', onData)
  socket.once('error', onError)
  socket.once('close', onClose)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
})
const connect = async (signal) => {
  if (signal.aborted) throw abortReason(signal)
  // Track before awaiting connect: a deadline must also own and destroy a
  // socket whose named-pipe connection is still pending.
  const socket = trackSocket(net.createConnection({ path: pipePath }))
  try {
    await onceEvent(socket, 'connect', { signal })
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}
export const monitorLines = (child) => {
  let output = ''
  let errors = ''
  let ended
  let childError
  let exit = { code: null, signal: null }
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
  const flushOutput = () => {
    if (!output) return
    deliver(output)
    output = ''
  }
  const rejectWaiters = (error) => {
    for (const waiting of waiters.values()) {
      for (const waiter of waiting) waiter.reject(error)
    }
    waiters.clear()
  }
  const onError = (error) => {
    childError = error
  }
  const onExit = (code, signal) => {
    // Exit only records process metadata. Node explicitly permits child stdio
    // to remain open after this event, including when another process shares it.
    exit = { code, signal }
  }
  const onStdoutEnd = () => {
    // `end` is the first point at which a final unterminated line is complete.
    flushOutput()
  }
  const onClose = (code, signal) => {
    // `close` follows process termination and stdio closure. Deliver every
    // buffered stdout line before rejecting requests the peer never emitted.
    flushOutput()
    if (exit.code === null && exit.signal === null) exit = { code, signal }
    ended = childError ?? new Error(
      `Rust peer closed (code ${exit.code}, signal ${exit.signal}): ${errors}`,
    )
    rejectWaiters(ended)
  }

  // Register process lifecycle handlers before touching stdio. Node permits
  // stdout/stderr to be absent when spawn itself fails.
  child.on('error', onError)
  child.on('exit', onExit)
  child.on('close', onClose)
  const stdout = child.stdout
  const stderr = child.stderr
  stdout?.setEncoding('utf8')
  stderr?.setEncoding('utf8')
  stdout?.on('data', onStdout)
  stdout?.on('end', onStdoutEnd)
  stderr?.on('data', onStderr)

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
      stdout?.off('data', onStdout)
      stdout?.off('end', onStdoutEnd)
      stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('close', onClose)
      rejectWaiters(new Error('Rust peer line monitor disposed'))
    }
  }
}
const waitForSuccessfulChild = (child, label) => new Promise((resolve, reject) => {
  let childError
  let errors = ''
  const onError = (error) => { childError = error }
  const onStderr = (chunk) => { errors += chunk }
  const cleanup = () => {
    child.off('error', onError)
    child.off('close', onClose)
    child.stderr?.off('data', onStderr)
  }
  const onClose = (code, signal) => {
    cleanup()
    if (childError) {
      reject(childError)
    } else if (code !== 0) {
      reject(new Error(`${label} failed (code ${code}, signal ${signal}): ${errors}`))
    } else {
      resolve()
    }
  }

  // A failed spawn may not provide stdio, so handle the process error first.
  child.on('error', onError)
  child.once('close', onClose)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', onStderr)
})
export const runWithDeadline = (operation, ms, onTimeout) => new Promise((resolve, reject) => {
  let timedOut = false
  const timer = setTimeout(async () => {
    timedOut = true
    clearTimeout(timer)
    const error = new Error(`timed out after ${ms}ms`)
    try {
      await onTimeout(error)
      reject(error)
    } catch (cleanupError) {
      reject(cleanupError)
    }
  }, ms)
  operation.then(
    (value) => {
      if (timedOut) return
      clearTimeout(timer)
      resolve(value)
    },
    (error) => {
      if (timedOut) return
      clearTimeout(timer)
      reject(error)
    },
  )
})
export const terminateChild = async (child, ms = 2_000) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const exitAbort = new AbortController()
  const exitTimer = setTimeout(
    () => exitAbort.abort(new Error(`child did not exit within ${ms}ms`)),
    ms,
  )
  try {
    const awaitExit = stageWait(onceEvent(child, 'exit', { signal: exitAbort.signal }))
    child.kill()
    await awaitExit()
  } catch {
    // The caller still releases the child's streams and event-loop reference.
  } finally {
    clearTimeout(exitTimer)
    exitAbort.abort()
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  }
}

const run = async () => {
  const operationAbort = new AbortController()
  let cleanupPromise
  const cleanup = (reason = new Error('Windows pipe harness cleanup')) => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      operationAbort.abort(reason)
      for (const socket of sockets) {
        socket.destroy()
        socket.unref()
      }
      sockets.clear()

      for (const child of [build, peer]) await terminateChild(child)
      peerLines?.dispose()
    })()
    return cleanupPromise
  }

  try {
    const buildSpec = peerBuildInvocation()
    build = spawn(buildSpec.command, buildSpec.args, {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    await runWithDeadline(
      waitForSuccessfulChild(build, 'Rust peer build'),
      60_000,
      cleanup,
    )

    const operation = (async () => {
      const peerSpec = peerRunInvocation()
      peer = spawn(peerSpec.command, peerSpec.args, {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      peerLines = monitorLines(peer)
      await peerLines.waitFor('READY')

      const active = await connect(operationAbort.signal)
      active.write(frame)
      const echoed = await readExactly(active, frame.length, operationAbort.signal)
      assert.deepEqual(echoed, frame, 'Rust transport must preserve Amber frame bytes for Node')

      const stalled = await connect(operationAbort.signal)
      const awaitStalledClosed = stageWait(
        onceEvent(stalled, 'close', { signal: operationAbort.signal }),
      )
      const awaitPeerExit = stageWait(
        onceEvent(peer, 'exit', { signal: operationAbort.signal }),
      )
      const awaitQueuedRead = stageWait(readExactly(
        stalled,
        Buffer.byteLength('queued-before-forced-close'),
        operationAbort.signal,
      ))
      await peerLines.waitFor('QUEUED')
      const queued = await awaitQueuedRead()
      assert.deepEqual(queued, Buffer.from('queued-before-forced-close'))
      // Acknowledge that Node consumed the queued bytes while its persistent
      // data listener keeps the socket flowing. This does not claim a kernel
      // read is pending; Node exposes no such synchronization point.
      active.write(Buffer.from([1]))
      await peerLines.waitFor('RELEASED')
      await awaitStalledClosed()
      const [exitCode] = await awaitPeerExit()
      assert.equal(exitCode, 0, 'Rust peer must exit cleanly after forcing peer release')
    })()
    await runWithDeadline(operation, 15_000, cleanup)
    console.log('PASS Node<->Rust frame, multi-client acceptance, live-reader forced close')
  } finally {
    await cleanup()
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.log('SKIP windows-pipe.mjs: Windows named pipes require Windows')
  } else {
    await run()
  }
}
