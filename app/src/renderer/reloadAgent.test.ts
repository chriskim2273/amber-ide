import { describe, expect, it } from 'vitest'
import { reloadAgentCommand } from './reloadAgent'

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const UUID = '91b9f942-914d-4ea0-8c29-cef2c8b3b984'

describe('reloadAgentCommand', () => {
  it('resumes the exact Codex string id with both required flags', () => {
    expect(reloadAgentCommand('codex', 'named session; still one argument'))
      .toBe(`codex resume 'named session; still one argument' ${CODEX_FLAGS}`)
    expect(reloadAgentCommand('codex', "abc'def"))
      .toBe(`codex resume 'abc'\\''def' ${CODEX_FLAGS}`)
  })

  it('opens the Codex picker without selecting the latest session', () => {
    const command = reloadAgentCommand('codex', null)
    expect(command).toBe(`codex resume ${CODEX_FLAGS}`)
    expect(command).not.toContain('--last')
  })

  it.each(['', '   ', 'line\nbreak', 'tab\tid', 'nul\0id', 'delete\u007fid'])
  ('rejects an invalid Codex id %j', (id) => {
    expect(reloadAgentCommand('codex', id)).toBeNull()
  })

  it('keeps Claude UUID validation and picker syntax unchanged', () => {
    expect(reloadAgentCommand('claude', UUID))
      .toBe(`claude --dangerously-skip-permissions --resume ${UUID}`)
    expect(reloadAgentCommand('claude', null))
      .toBe('claude --dangerously-skip-permissions --resume')
    expect(reloadAgentCommand('claude', 'named-session')).toBeNull()
  })

  it('keeps Grok UUID validation and picker syntax unchanged', () => {
    expect(reloadAgentCommand('grok', UUID))
      .toBe(`grok --permission-mode bypassPermissions --resume ${UUID}`)
    expect(reloadAgentCommand('grok', null))
      .toBe('grok --permission-mode bypassPermissions --resume')
    expect(reloadAgentCommand('grok', 'named-session')).toBeNull()
  })
})
