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
let build

const peerDirectory = (repoRoot) => path.join(
  repoRoot,
  'crates', 'amber', 'tests', 'windows_pipe_peer',
)
const peerManifest = (repoRoot) => path.join(peerDirectory(repoRoot), 'Cargo.toml')
export const peerBuildInvocation = ({
  repoRoot = repo,
  cargo = process.env.CARGO ?? 'cargo',
} = {}) => ({
  command: cargo,
  args: [
    'build', '--message-format=json', '--manifest-path', peerManifest(repoRoot),
    '--bin', 'windows_pipe_peer',
  ],
})
export const peerExecutableFromCargo = (output, {
  repoRoot = repo,
  platform = process.platform,
} = {}) => {
  const expectedManifest = path.resolve(peerManifest(repoRoot))
  let executable

  for (const line of output.split(/\r?\n/)) {
    // Cargo documents one JSON object per line and warns that other build
    // tools can still write arbitrary output. Only JSON-looking lines enter
    // the parser, and only this manifest's named binary can become the peer.
    if (!line.startsWith('{')) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (
      message?.reason !== 'compiler-artifact'
      || message?.target?.name !== 'windows_pipe_peer'
      || !Array.isArray(message.target.kind)
      || !message.target.kind.includes('bin')
      || typeof message.manifest_path !== 'string'
      || typeof message.executable !== 'string'
      || message.executable.length === 0
    ) continue

    const actualManifest = path.resolve(message.manifest_path)
    const sameManifest = platform === 'win32'
      ? actualManifest.toLowerCase() === expectedManifest.toLowerCase()
      : actualManifest === expectedManifest
    if (!sameManifest) continue
    if (!path.isAbsolute(message.executable)) {
      throw new Error(`Cargo reported a non-absolute peer executable: ${message.executable}`)
    }
    if (executable && executable !== message.executable) {
      throw new Error('Cargo reported multiple peer executables')
    }
    executable = message.executable
  }

  if (!executable) {
    throw new Error('Cargo did not report the windows_pipe_peer executable artifact')
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
export const waitForSuccessfulChild = (child, label) => new Promise((resolve, reject) => {
  let childError
  let output = ''
  let errors = ''
  const onError = (error) => { childError = error }
  const onStdout = (chunk) => { output += chunk }
  const onStderr = (chunk) => { errors += chunk }
  const cleanup = () => {
    child.off('error', onError)
    child.off('close', onClose)
    child.stdout?.off('data', onStdout)
    child.stderr?.off('data', onStderr)
  }
  const onClose = (code, signal) => {
    cleanup()
    if (childError) {
      reject(childError)
    } else if (code !== 0) {
      reject(new Error(`${label} failed (code ${code}, signal ${signal}): ${errors}`))
    } else {
      resolve({ stdout: output, stderr: errors })
    }
  }

  // A failed spawn may not provide stdio, so handle the process error first.
  child.on('error', onError)
  child.once('close', onClose)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', onStdout)
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
const childExited = (child) => child.exitCode !== null || child.signalCode !== null
export const releaseChild = (child) => {
  if (!child) return
  const streams = child.stdio ?? [child.stdin, child.stdout, child.stderr]
  for (const stream of new Set(streams)) stream?.destroy?.()
  child.unref?.()
}
const waitForChildExit = (child, ms) => new Promise((resolve, reject) => {
  if (childExited(child)) {
    resolve()
    return
  }
  const timer = setTimeout(() => {
    cleanup()
    reject(new Error(`child ${child.pid ?? '<unknown>'} did not exit within ${ms}ms`))
  }, ms)
  const onError = (error) => {
    cleanup()
    reject(error)
  }
  const onExit = () => {
    cleanup()
    resolve()
  }
  const cleanup = () => {
    clearTimeout(timer)
    child.off('error', onError)
    child.off('exit', onExit)
  }
  child.once('error', onError)
  child.once('exit', onExit)
  if (childExited(child)) onExit()
})
export const terminateChild = async (child, ms = 2_000, {
  platform = process.platform,
  spawnChild = spawn,
} = {}) => {
  if (!child) return
  let killer
  try {
    if (childExited(child)) return
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      throw new Error('cannot terminate a live child without a process id')
    }

    const awaitExit = stageWait(waitForChildExit(child, ms))
    if (platform === 'win32') {
      // Microsoft documents /T as terminating the PID and its descendants;
      // /F prevents Cargo or a compiler child from extending the harness
      // deadline with user-mode signal handling.
      killer = spawnChild(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      try {
        await runWithDeadline(
          waitForSuccessfulChild(killer, `taskkill process tree ${child.pid}`),
          ms,
          async () => {
            if (!childExited(killer)) {
              const signaled = killer.kill()
              if (!signaled && !childExited(killer)) {
                throw new Error(`failed to stop taskkill for child ${child.pid}`)
              }
            }
            releaseChild(killer)
          },
        )
      } catch (error) {
        // The target can finish naturally between the initial state check and
        // taskkill's PID lookup. A taskkill error is cleanup failure only if
        // the target still needs termination.
        if (!childExited(child)) throw error
      }
    } else {
      const signaled = child.kill()
      if (!signaled && !childExited(child)) {
        throw new Error(`failed to signal child ${child.pid}`)
      }
    }
    await awaitExit()
  } finally {
    // `exit` can precede inherited stdio closure. The harness owns these pipe
    // ends, so release them and the event-loop reference on every outcome.
    releaseChild(killer)
    releaseChild(child)
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

      peerLines?.dispose()
      const failures = []
      for (const child of [build, peer]) {
        try {
          await terminateChild(child)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Windows pipe harness child cleanup failed')
      }
    })()
    return cleanupPromise
  }

  try {
    const buildSpec = peerBuildInvocation()
    build = spawn(buildSpec.command, buildSpec.args, {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const buildResult = await runWithDeadline(
      waitForSuccessfulChild(build, 'Rust peer build'),
      60_000,
      cleanup,
    )
    const executable = peerExecutableFromCargo(buildResult.stdout)
    const executableStat = await stat(executable)
    if (!executableStat.isFile()) {
      throw new Error(`Cargo peer executable artifact is not a file: ${executable}`)
    }

    const operation = (async () => {
      const peerSpec = peerRunInvocation({ executable })
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
