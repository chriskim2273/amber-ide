import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once as onceEvent } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  monitorLines,
  peerBuildInvocation,
  peerRunInvocation,
  readExactly,
  runWithDeadline,
  stageWait,
  terminateChild,
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

test('peer invocations build first and run the platform executable directly', () => {
  const repoRoot = path.resolve(path.sep, 'checkout')
  const manifest = path.join(
    repoRoot,
    'crates', 'amber', 'tests', 'windows_pipe_peer', 'Cargo.toml',
  )
  const windowsExecutable = path.join(
    repoRoot,
    'crates', 'amber', 'tests', 'windows_pipe_peer',
    'target', 'debug', 'windows_pipe_peer.exe',
  )
  const targetDirectory = path.join(
    repoRoot,
    'crates', 'amber', 'tests', 'windows_pipe_peer', 'target',
  )

  assert.deepEqual(
    peerBuildInvocation({ repoRoot, cargo: 'custom-cargo' }),
    {
      command: 'custom-cargo',
      args: [
        'build', '-q', '--manifest-path', manifest,
        '--target-dir', targetDirectory,
      ],
    },
  )
  assert.deepEqual(
    peerRunInvocation({ repoRoot, platform: 'win32', endpoint: 'test-pipe' }),
    {
      command: windowsExecutable,
      args: ['test-pipe'],
    },
  )
  assert.equal(
    peerRunInvocation({ repoRoot, platform: 'linux', endpoint: 'test-pipe' }).command,
    windowsExecutable.slice(0, -4),
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
