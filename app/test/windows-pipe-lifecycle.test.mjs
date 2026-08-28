import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { monitorLines, runWithDeadline } from './windows-pipe.mjs'

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
