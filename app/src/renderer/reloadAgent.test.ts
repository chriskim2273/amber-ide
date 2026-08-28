import { describe, expect, it } from 'vitest'
import { reloadAgentCommand } from './reloadAgent'

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const UUID = '91b9f942-914d-4ea0-8c29-cef2c8b3b984'

describe('reloadAgentCommand', () => {
  it('resumes the exact Codex string id with both required flags', () => {
    expect(reloadAgentCommand('codex', 'named session; still one argument'))
      .toBe(`codex resume ${CODEX_FLAGS} -- 'named session; still one argument'`)
    expect(reloadAgentCommand('codex', "abc'def"))
      .toBe(`codex resume ${CODEX_FLAGS} -- 'abc'\\''def'`)
  })

  it('treats an option-shaped Codex id as the literal recorded id', () => {
    expect(reloadAgentCommand('codex', '--last'))
      .toBe(`codex resume ${CODEX_FLAGS} -- '--last'`)
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

  it('resumes OpenCode with -s and never --continue', () => {
    const id = 'ses_fd8f8accaffeTWUvgvTimbhECs'
    const command = reloadAgentCommand('opencode', id)
    expect(command).toBe(`opencode --auto -s '${id}'`)
    expect(command).not.toContain('--continue')
    expect(command).not.toContain(' -c')
  })

  it('starts a fresh OpenCode session when no id is recorded', () => {
    const command = reloadAgentCommand('opencode', null)
    expect(command).toBe('opencode --auto')
    expect(command).not.toContain('-s')
    expect(command).not.toContain('--continue')
  })

  it('resumes Hermes by its exact recorded id', () => {
    const id = '20260827_091523_a1b2c3'
    const command = reloadAgentCommand('hermes', id)
    expect(command).toBe(`hermes --yolo --resume '${id}'`)
    expect(command).not.toContain('--continue')
  })

  it('starts a fresh Hermes session when no id is recorded', () => {
    expect(reloadAgentCommand('hermes', null)).toBe('hermes --yolo')
  })

  it.each(['', '   ', 'latest', '20260827_091523_zzzzzz', '20260827-091523-a1b2c3', 'line\nbreak'])
  ('rejects an invalid Hermes id %j', (id) => {
    expect(reloadAgentCommand('hermes', id)).toBeNull()
  })

  it.each(['', '   ', 'latest', 'ses_', 'ses_has-dash', 'line\nbreak'])
  ('rejects an invalid OpenCode id %j', (id) => {
    expect(reloadAgentCommand('opencode', id)).toBeNull()
  })
})
