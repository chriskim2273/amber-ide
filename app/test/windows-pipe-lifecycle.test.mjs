import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once as onceEvent } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  monitorLines,
  peerRunInvocation,
  readExactly,
  resolvePeerExecutable,
  runEntrypoint,
  runWithDeadline,
  spawnPeer,
  stageWait,
  startPeer,
  stopPeer,
  terminateChild,
} from './windows-pipe.mjs'

test('line monitor delivers peer records and removes listeners on dispose', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('READY')"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = monitorLines(child)
  const awaitClose = stageWait(onceEvent(child, 'close'))

  try {
    await lines.waitFor('READY')
    await awaitClose()
    assert.equal(child.exitCode, 0)
  } finally {
    lines.dispose()
  }
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('close'), 0)
})

test('deadline finishes cleanup before rejecting the operation', async () => {
  let cleaned = false

  await assert.rejects(
    runWithDeadline(new Promise(() => {}), 10, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      cleaned = true
    }),
    /timed out after 10ms/,
  )
  assert.equal(cleaned, true)
})

test('deadline surfaces cleanup failure instead of hiding it', async () => {
  const cleanupError = new Error('peer could not be reaped')
  await assert.rejects(
    runWithDeadline(new Promise(() => {}), 10, async () => { throw cleanupError }),
    cleanupError,
  )
})

test('pre-created event and read waits handle abort until their awaited point', async () => {
  const controller = new AbortController()
  const emitter = new EventEmitter()
  const stream = new PassThrough()
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)

  try {
    const awaitEvent = stageWait(onceEvent(emitter, 'ready', { signal: controller.signal }))
    const awaitRead = stageWait(readExactly(stream, 1, controller.signal))
    const reason = new Error('test deadline expired')

    controller.abort(reason)
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(unhandled, [])
    await assert.rejects(awaitEvent(), (error) => error.name === 'AbortError')
    await assert.rejects(awaitRead(), reason)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    stream.destroy()
  }
})

test('line monitor reports a failed spawn when child stdio is absent', async () => {
  const child = new EventEmitter()
  child.stdout = undefined
  child.stderr = undefined
  const lines = monitorLines(child)
  const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })

  queueMicrotask(() => {
    child.emit('error', spawnError)
    child.emit('close', -1, null)
  })

  try {
    await assert.rejects(lines.waitFor('READY'), spawnError)
  } finally {
    lines.dispose()
  }
})

test('Windows peer path is required and must be absolute before stat or spawn', async () => {
  let stats = 0
  let spawns = 0
  const statPath = async () => {
    stats += 1
    return { isFile: () => true }
  }
  const spawnChild = () => {
    spawns += 1
    throw new Error('must not spawn')
  }

  await assert.rejects(
    startPeer({ env: {}, platform: 'win32', statPath, spawnChild }),
    /AMBER_WINDOWS_PIPE_PEER is required on Windows/,
  )
  await assert.rejects(
    startPeer({
      env: { AMBER_WINDOWS_PIPE_PEER: 'windows_pipe_peer.exe' },
      platform: 'win32',
      statPath,
      spawnChild,
    }),
    /AMBER_WINDOWS_PIPE_PEER must be an absolute path/,
  )
  assert.equal(stats, 0)
  assert.equal(spawns, 0)
})

test('Windows peer path must identify a file', async () => {
  const executable = String.raw`C:\amber-ci\windows_pipe_peer.exe`
  await assert.rejects(
    resolvePeerExecutable({
      env: { AMBER_WINDOWS_PIPE_PEER: executable },
      platform: 'win32',
      statPath: async () => ({ isFile: () => false }),
    }),
    /AMBER_WINDOWS_PIPE_PEER is not a file/,
  )
  await assert.rejects(
    resolvePeerExecutable({
      env: { AMBER_WINDOWS_PIPE_PEER: executable },
      platform: 'win32',
      statPath: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    }),
    /AMBER_WINDOWS_PIPE_PEER does not name an existing file/,
  )
})

test('Windows peer path reports access-denied stat failures with their cause', async () => {
  const executable = String.raw`C:\amber-ci\windows_pipe_peer.exe`
  const accessDenied = Object.assign(new Error('access denied by fixture'), { code: 'EACCES' })

  await assert.rejects(
    resolvePeerExecutable({
      env: { AMBER_WINDOWS_PIPE_PEER: executable },
      platform: 'win32',
      statPath: async () => { throw accessDenied },
    }),
    (error) => {
      assert.match(error.message, /could not inspect.*\(EACCES\)/)
      assert.equal(error.cause, accessDenied)
      return true
    },
  )
})

test('validated peer path is spawned directly with only the endpoint argument', async () => {
  const executable = String.raw`C:\amber-ci\windows_pipe_peer.exe`
  let invocation
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr]
  const returned = await startPeer({
    env: { AMBER_WINDOWS_PIPE_PEER: executable },
    platform: 'win32',
    statPath: async () => ({ isFile: () => true }),
    endpoint: 'amber-proof-endpoint',
    spawnChild: (...args) => {
      invocation = args
      return child
    },
  })

  assert.equal(returned, child)
  assert.deepEqual(peerRunInvocation({ executable, endpoint: 'amber-proof-endpoint' }), {
    command: executable,
    args: ['amber-proof-endpoint'],
  })
  assert.equal(invocation[0], executable)
  assert.deepEqual(invocation[1], ['amber-proof-endpoint'])
  assert.deepEqual(invocation[2].stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(invocation[2].shell, false)
  assert.equal(invocation[2].windowsHide, true)
  assert.equal(path.isAbsolute(invocation[2].cwd), true)
})

test('Windows executable paths containing spaces remain one direct spawn command', () => {
  const executable = String.raw`C:\Program Files\Amber CI\windows_pipe_peer.exe`
  let invocation
  const child = new EventEmitter()

  const returned = spawnPeer({
    executable,
    endpoint: 'amber proof endpoint',
    spawnChild: (...args) => {
      invocation = args
      return child
    },
  })

  assert.equal(returned, child)
  assert.equal(invocation[0], executable)
  assert.deepEqual(invocation[1], ['amber proof endpoint'])
  assert.equal(invocation[2].shell, false)
})

test('harness contains no build launcher, process-tree killer, or target guess', async () => {
  const source = await readFile(new URL('./windows-pipe.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bcargo\b/i)
  assert.doesNotMatch(source, /\btaskkill(?:\.exe)?\b/i)
  assert.doesNotMatch(source, /target[\\/]debug/i)
})

test('direct peer spawn is terminated and observed exiting before release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'amber-peer-lifecycle-'))
  const script = path.join(directory, 'peer-fixture.mjs')
  await writeFile(script, 'setInterval(() => {}, 1_000)\n')
  const child = spawnPeer({ executable: process.execPath, endpoint: script })

  try {
    await onceEvent(child, 'spawn')
    assert.equal(child.spawnfile, process.execPath)
    await terminateChild(child, 1_000)
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await onceEvent(child, 'exit')
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('protocol grace permits a directly owned peer to exit without signaling', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let kills = 0
  const originalKill = child.kill.bind(child)
  child.kill = (...args) => {
    kills += 1
    return originalKill(...args)
  }

  await onceEvent(child, 'spawn')
  await stopPeer(child, 500, 250)
  assert.equal(kills, 0)
  assert.equal(child.exitCode, 0)
})

test('failed termination keeps a known-live peer and its streams referenced', async () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr]
  child.kill = () => false
  child.unref = () => { throw new Error('live child must not be unreferenced') }

  await assert.rejects(terminateChild(child, 20), /failed to terminate peer 4242/)
  assert.equal(child.stdout.destroyed, false)
  assert.equal(child.stderr.destroyed, false)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
})

test('thrown termination error also clears wait listeners without releasing peer', async () => {
  const child = new EventEmitter()
  child.pid = 4343
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr]
  const killError = Object.assign(new Error('access denied'), { code: 'EPERM' })
  child.kill = () => { throw killError }

  await assert.rejects(terminateChild(child, 20), killError)
  assert.equal(child.stdout.destroyed, false)
  assert.equal(child.stderr.destroyed, false)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
})

test('entrypoint reports cleanup timeout and remains pending until the live peer exits', async () => {
  const child = new EventEmitter()
  child.pid = 4444
  child.exitCode = null
  child.signalCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr]
  child.kill = () => true
  child.unref = () => { throw new Error('live child must not be unreferenced') }
  const processState = { exitCode: undefined }
  let reported = ''
  let finished = false
  let monitorReleased = false

  const entrypoint = runEntrypoint({
    execute: () => terminateChild(child, 20),
    getLivePeer: () => child,
    processState,
    writeError: (message) => { reported += message },
    releasePeerMonitor: () => { monitorReleased = true },
  }).then(() => { finished = true })

  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(processState.exitCode, 1)
  assert.match(reported, /peer 4444 did not exit within 20ms/)
  assert.equal(finished, false)
  assert.equal(child.listenerCount('error'), 1)
  assert.equal(child.listenerCount('exit'), 1)
  assert.equal(child.stdout.destroyed, false)
  assert.equal(child.stderr.destroyed, false)
  assert.equal(monitorReleased, false)

  child.exitCode = 1
  child.emit('exit', 1, null)
  await entrypoint
  assert.equal(finished, true)
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
  assert.equal(monitorReleased, true)
})
