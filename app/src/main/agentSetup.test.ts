import { describe, expect, it } from 'vitest'
import { repairAgentExtensions } from './agentSetup'

describe('repairAgentExtensions', () => {
  it('still repairs Pi when the preceding Codex repair rejects', async () => {
    const calls: string[][] = []
    const warnings: string[] = []
    await repairAgentExtensions(
      async (args) => {
        calls.push(args)
        if (args[1] === 'install-codex-skill') throw new Error('codex unavailable')
        return { code: 0, stderr: '' }
      },
      (warning) => warnings.push(warning),
    )

    expect(calls).toEqual([
      ['ctl', 'install-codex-skill'],
      ['ctl', 'install-pi-extension'],
    ])
    expect(warnings.join('\n')).toContain('codex unavailable')
  })
})
