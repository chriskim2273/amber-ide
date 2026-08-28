// Windows-only Node <-> Rust named-pipe proof. It starts an isolated Rust
// transport peer, exchanges an Amber protocol frame, then verifies that a
// queued write followed by Rust's forced close is observed by a live Node
// reader. Node/libuv exposes flowing-mode and close events, but no hook at the
// exact underlying ReadFile call; the Rust test covers that lower-level proof.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once as onceEvent } from 'node:events'
import { stat } from 'node:fs/promises'
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
const peerPathVariable = 'AMBER_WINDOWS_PIPE_PEER'

export const resolvePeerExecutable = async ({
  env = process.env,
  platform = process.platform,
  statPath = stat,
} = {}) => {
  const executable = env[peerPathVariable]
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error(`${peerPathVariable} is required on Windows`)
  }
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  if (!platformPath.isAbsolute(executable)) {
    throw new Error(`${peerPathVariable} must be an absolute path: ${executable}`)
  }

  let executableStat
  try {
    executableStat = await statPath(executable)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`${peerPathVariable} does not name an existing file: ${executable}`, {
        cause: error,
      })
    }
    throw new Error(
      `${peerPathVariable} could not inspect ${executable} (${code ?? 'unknown stat error'})`,
      { cause: error },
    )
  }
  if (!executableStat.isFile()) {
    throw new Error(`${peerPathVariable} is not a file: ${executable}`)
  }
  return executable
}
export const peerRunInvocation = ({
  executable,
  endpoint: targetEndpoint = endpoint,
} = {}) => {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('peer executable path is required')
  }
  return { command: executable, args: [targetEndpoint] }
}
export const spawnPeer = ({
  executable,
  endpoint: targetEndpoint = endpoint,
  spawnChild = spawn,
} = {}) => {
  const spec = peerRunInvocation({ executable, endpoint: targetEndpoint })
  return spawnChild(spec.command, spec.args, {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  })
}
export const startPeer = async ({
  env = process.env,
  platform = process.platform,
  statPath = stat,
  endpoint: targetEndpoint = endpoint,
  spawnChild = spawn,
} = {}) => {
  const executable = await resolvePeerExecutable({ env, platform, statPath })
  return spawnPeer({ executable, endpoint: targetEndpoint, spawnChild })
}

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
const childExited = (child) => child.exitCode !== null || child.signalCode !== null
const peerExitTimeout = (child, ms) => Object.assign(
  new Error(`peer ${child.pid ?? '<unknown>'} did not exit within ${ms}ms`),
  { code: 'ERR_AMBER_PEER_EXIT_TIMEOUT' },
)
const releaseExitedChild = (child) => {
  if (!child || childExited(child) || child.pid === undefined) {
    const streams = child?.stdio ?? [child?.stdin, child?.stdout, child?.stderr]
    for (const stream of new Set(streams)) stream?.destroy?.()
    return
  }
  throw new Error(`refusing to release live peer ${child.pid}`)
}
const retainLivePeerUntilExit = (child) => {
  if (!child || childExited(child) || child.pid === undefined) {
    releaseExitedChild(child)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    const onError = () => {}
    const onExit = () => {
      if (settled) return
      settled = true
      child.off('error', onError)
      child.off('exit', onExit)
      releaseExitedChild(child)
      resolve()
    }
    // A cleanup failure must leave an explicit process-handle lease behind.
    // Do not unref the child: the entrypoint remains pending until real exit.
    child.on('error', onError)
    child.once('exit', onExit)
    if (childExited(child)) onExit()
  })
}
const waitForChildExit = (child, ms, signal) => new Promise((resolve, reject) => {
  if (childExited(child)) {
    resolve()
    return
  }
  let settled = false
  const finish = (callback, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.off('error', onError)
    child.off('exit', onExit)
    signal?.removeEventListener('abort', onAbort)
    callback(value)
  }
  const timer = setTimeout(() => {
    finish(reject, peerExitTimeout(child, ms))
  }, ms)
  const onError = (error) => finish(reject, error)
  const onExit = () => finish(resolve)
  const onAbort = () => finish(reject, abortReason(signal))
  child.once('error', onError)
  child.once('exit', onExit)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  if (childExited(child)) onExit()
})
export const terminateChild = async (child, ms = 2_000) => {
  if (!child) return
  if (childExited(child) || child.pid === undefined) {
    releaseExitedChild(child)
    return
  }

  const waitAbort = new AbortController()
  const awaitExit = stageWait(waitForChildExit(child, ms, waitAbort.signal))
  let signaled
  try {
    signaled = child.kill()
  } catch (error) {
    waitAbort.abort(error)
    throw error
  }
  if (!signaled && !childExited(child)) {
    waitAbort.abort(new Error(`failed to terminate peer ${child.pid}`))
    // Keep the known-live child and its stdio referenced so this failure cannot
    // be mistaken for successful cleanup or silently outlive the harness.
    throw new Error(`failed to terminate peer ${child.pid}`)
  }
  try {
    await awaitExit()
  } finally {
    waitAbort.abort()
  }
  releaseExitedChild(child)
}
export const stopPeer = async (child, ms = 2_000, gracefulMs = 250) => {
  if (!child) return
  if (childExited(child) || child.pid === undefined) {
    releaseExitedChild(child)
    return
  }

  const grace = Math.min(gracefulMs, ms)
  try {
    // Socket cleanup closes the protocol channels first. The standalone peer
    // treats that EOF as shutdown, so normal and timed-out proofs can exit
    // without an out-of-band process signal.
    await waitForChildExit(child, grace)
    releaseExitedChild(child)
    return
  } catch (error) {
    if (childExited(child)) {
      releaseExitedChild(child)
      return
    }
    if (error?.code !== 'ERR_AMBER_PEER_EXIT_TIMEOUT') throw error
  }

  await terminateChild(child, Math.max(1, ms - grace))
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

      let peerStopped = false
      try {
        await stopPeer(peer)
        peerStopped = true
      } finally {
        // Keep draining a known-live peer after cleanup failure. The entrypoint
        // releases this monitor only after its explicit exit lease settles.
        if (peerStopped || !peer || childExited(peer) || peer.pid === undefined) {
          peerLines?.dispose()
        }
      }
    })()
    return cleanupPromise
  }

  try {
    const operation = (async () => {
      peer = await startPeer()
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

export const runEntrypoint = async ({
  execute = run,
  getLivePeer = () => peer,
  processState = process,
  writeError = (message) => process.stderr.write(message),
  releasePeerMonitor = () => peerLines?.dispose(),
} = {}) => {
  try {
    await execute()
  } catch (error) {
    processState.exitCode = 1
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    writeError(`${message}\n`)
    try {
      await retainLivePeerUntilExit(getLivePeer())
    } finally {
      releasePeerMonitor()
    }
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.log('SKIP windows-pipe.mjs: Windows named pipes require Windows')
  } else {
    await runEntrypoint()
  }
}
