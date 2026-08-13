import { describe, expect, it } from 'vitest'
import { spawnOkWithStderr } from './spawnOk'

describe('spawnOkWithStderr', () => {
  it('surfaces stderr from a successful process', async () => {
    let surfaced = ''

    await spawnOkWithStderr(
      process.execPath,
      ['-e', "process.stderr.write('ownership warning\\n')"],
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
