import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once as onceEvent } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  monitorLines,
  peerBuildInvocation,
  peerExecutableFromCargo,
  peerRunInvocation,
  readExactly,
  runWithDeadline,
  stageWait,
  terminateChild,
  waitForSuccessfulChild,
} from './windows-pipe.mjs'

test('line monitor drains inherited stdout after the direct child exits', async () => {
  const grandchild = [
    "const child = require('node:child_process').spawn(",
    '  process.execPath,',
    `  ['-e', "setTimeout(() => process.stdout.write('RELEASED'), 100)"],`,
    "  { stdio: ['ignore', 1, 2] },",
    ')',
    'child.unref()',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', grandchild], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = monitorLines(child)

  try {
    await lines.waitFor('RELEASED')
    assert.equal(child.exitCode, 0)
  } finally {
    lines.dispose()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})

test('deadline finishes cleanup before rejecting the operation', async () => {
  let cleaned = false
  const pending = new Promise(() => {})

  await assert.rejects(
    runWithDeadline(pending, 10, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      cleaned = true
    }),
    /timed out after 10ms/,
  )
  assert.equal(cleaned, true)
})

test('deadline surfaces cleanup failure instead of hiding it', async () => {
  const cleanupError = new Error('process tree could not be reaped')
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

test('child completion wait reports failed spawn when stdio is absent', async () => {
  const child = new EventEmitter()
  child.stdout = undefined
  child.stderr = undefined
  const spawnError = Object.assign(new Error('build spawn failed'), { code: 'ENOENT' })
  const completed = waitForSuccessfulChild(child, 'test build')

  queueMicrotask(() => {
    child.emit('error', spawnError)
    child.emit('close', -1, null)
  })

  await assert.rejects(completed, spawnError)
})

test('peer build requests Cargo JSON and direct run uses its exact artifact', () => {
  const repoRoot = path.resolve(path.sep, 'checkout')
  const manifest = path.join(
    repoRoot,
    'crates', 'amber', 'tests', 'windows_pipe_peer', 'Cargo.toml',
  )
  const configuredExecutable = path.join(path.sep, 'custom-target', 'host', 'peer.exe')

  assert.deepEqual(
    peerBuildInvocation({ repoRoot, cargo: 'custom-cargo' }),
    {
      command: 'custom-cargo',
      args: [
        'build', '--message-format=json', '--manifest-path', manifest,
        '--bin', 'windows_pipe_peer',
      ],
    },
  )
  assert.deepEqual(
    peerRunInvocation({ executable: configuredExecutable, endpoint: 'test-pipe' }),
    {
      command: configuredExecutable,
      args: ['test-pipe'],
    },
  )
  assert.throws(
    () => peerRunInvocation({ endpoint: 'test-pipe' }),
    /peer executable path is required/,
  )
})

test('Cargo artifact parser selects only this manifest named binary', () => {
  const repoRoot = path.resolve(path.sep, 'checkout')
  const manifest = path.join(
    repoRoot,
    'crates', 'amber', 'tests', 'windows_pipe_peer', 'Cargo.toml',
  )
  const executable = path.resolve(path.sep, 'cargo-target', 'custom', 'windows_pipe_peer')
  const output = [
    'a build tool wrote a non-JSON status line',
    '{malformed JSON from an arbitrary tool',
    JSON.stringify({
      reason: 'compiler-artifact',
      manifest_path: path.join(repoRoot, 'dependency', 'Cargo.toml'),
      target: { name: 'windows_pipe_peer', kind: ['bin'] },
      executable: path.resolve(path.sep, 'wrong-package', 'windows_pipe_peer'),
    }),
    JSON.stringify({
      reason: 'compiler-artifact',
      manifest_path: manifest,
      target: { name: 'amber_core', kind: ['lib'] },
      executable: null,
    }),
    JSON.stringify({
      reason: 'compiler-artifact',
      manifest_path: manifest,
      target: { name: 'windows_pipe_peer', kind: ['bin'] },
      executable,
    }),
    JSON.stringify({ reason: 'build-finished', success: true }),
  ].join('\n')

  assert.equal(peerExecutableFromCargo(output, { repoRoot, platform: 'linux' }), executable)
  assert.throws(
    () => peerExecutableFromCargo('{"reason":"build-finished","success":true}', {
      repoRoot,
      platform: 'linux',
    }),
    /did not report the windows_pipe_peer executable artifact/,
  )
  const relativeArtifact = JSON.stringify({
    reason: 'compiler-artifact',
    manifest_path: manifest,
    target: { name: 'windows_pipe_peer', kind: ['bin'] },
    executable: 'target/debug/windows_pipe_peer',
  })
  assert.throws(
    () => peerExecutableFromCargo(relativeArtifact, { repoRoot, platform: 'linux' }),
    /non-absolute peer executable/,
  )
})

test('child cleanup terminates a directly spawned process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await onceEvent(child, 'spawn')
    await terminateChild(child, 1_000)
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
})

test('child cleanup releases inherited stdio even after direct child exit', async () => {
  const script = [
    "const child = require('node:child_process').spawn(",
    '  process.execPath,',
    `  ['-e', 'setTimeout(() => {}, 200)'],`,
    "  { stdio: ['ignore', 1, 2] },",
    ')',
    'child.unref()',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await onceEvent(child, 'exit')
  assert.equal(child.stdout.destroyed, false)
  await terminateChild(child)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
})

test('Windows cleanup uses taskkill tree and surfaces failed killer spawn', async () => {
  const target = new EventEmitter()
  target.pid = 4242
  target.exitCode = null
  target.signalCode = null
  target.stdio = [null, new PassThrough(), new PassThrough()]
  target.unref = () => { target.unreferenced = true }

  const killer = new EventEmitter()
  killer.exitCode = null
  killer.signalCode = null
  killer.stdout = undefined
  killer.stderr = undefined
  killer.stdio = [null, null, null]
  killer.unref = () => { killer.unreferenced = true }
  const spawnError = Object.assign(new Error('taskkill spawn failed'), { code: 'ENOENT' })
  let invocation
  const spawnChild = (...args) => {
    invocation = args
    queueMicrotask(() => {
      killer.emit('error', spawnError)
      killer.emit('close', -1, null)
    })
    return killer
  }

  await assert.rejects(
    terminateChild(target, 20, { platform: 'win32', spawnChild }),
    spawnError,
  )
  assert.deepEqual(invocation, [
    'taskkill.exe',
    ['/PID', '4242', '/T', '/F'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  ])
  assert.equal(target.stdio[1].destroyed, true)
  assert.equal(target.stdio[2].destroyed, true)
  assert.equal(target.unreferenced, true)
  assert.equal(killer.unreferenced, true)
})

test('Windows cleanup requires the taskkill target to be reaped', async () => {
  const target = new EventEmitter()
  target.pid = 4343
  target.exitCode = null
  target.signalCode = null
  target.stdio = [null, new PassThrough(), new PassThrough()]
  target.unref = () => { target.unreferenced = true }

  const killer = new EventEmitter()
  killer.pid = 4444
  killer.exitCode = null
  killer.signalCode = null
  killer.stdout = new PassThrough()
  killer.stderr = new PassThrough()
  killer.stdio = [null, killer.stdout, killer.stderr]
  killer.unref = () => { killer.unreferenced = true }
  const spawnChild = () => {
    queueMicrotask(() => {
      killer.exitCode = 0
      killer.emit('close', 0, null)
    })
    return killer
  }

  await assert.rejects(
    terminateChild(target, 20, { platform: 'win32', spawnChild }),
    /child 4343 did not exit within 20ms/,
  )
  assert.equal(target.stdio[1].destroyed, true)
  assert.equal(target.stdio[2].destroyed, true)
  assert.equal(target.unreferenced, true)
  assert.equal(killer.stdout.destroyed, true)
  assert.equal(killer.stderr.destroyed, true)
  assert.equal(killer.unreferenced, true)
})
