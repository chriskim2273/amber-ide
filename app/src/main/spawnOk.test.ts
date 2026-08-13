import { describe, expect, it } from 'vitest'
import { spawnOkWithStderr } from './spawnOk'

describe('spawnOkWithStderr', () => {
  it('surfaces stderr from a successful process', async () => {
    let surfaced = ''
    const lateWriter = "setTimeout(() => process.stderr.write('ownership warning\\n'), 50)"
    const script = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', ${JSON.stringify(lateWriter)}], {
        detached: true,
        stdio: ['ignore', 'ignore', 2],
      }).unref()
    `

    await spawnOkWithStderr(
      process.execPath,
      ['-e', script],
      (stderr) => { surfaced += stderr },
    )

    expect(surfaced).toBe('ownership warning\n')
  })

  it('stays quiet when a successful process writes no stderr', async () => {
    let surfaced = ''

    await spawnOkWithStderr(process.execPath, ['-e', ''], (stderr) => { surfaced += stderr })

    expect(surfaced).toBe('')
  })
})
