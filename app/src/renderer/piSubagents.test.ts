import { describe, expect, it } from 'vitest'
import { normalizeSubagentStatus, subagentCanControl, subagentCanLoadTranscript } from './piModel'
import { requestBusyForRun, shouldClearSteerDraft, shouldSubmitSteerKey, type RequestOwner } from './PiSubagents'

describe('Pi subagent controls', () => {
  it('tracks exact request ownership instead of matching request-id text', () => {
    const owners = new Map<string, RequestOwner>([['subagent-stop-random', { runId: 'run-1', action: 'stop' }]])
    expect(requestBusyForRun(owners, 'run-1')).toBe(true)
    expect(requestBusyForRun(owners, 'run-10')).toBe(false)
  })

  it('clears a steer draft only after its success receipt and unchanged edit version', () => {
    const owner: RequestOwner = { runId: 'run-1', action: 'steer', draft: 'hello', draftVersion: 2 }
    expect(shouldClearSteerDraft(owner, true, 'hello', 2)).toBe(true)
    expect(shouldClearSteerDraft(owner, false, 'hello', 2)).toBe(false)
    expect(shouldClearSteerDraft(owner, true, 'newer', 3)).toBe(false)
    const whitespaceOwner: RequestOwner = { runId: 'run-1', action: 'steer', draft: '  hello  ', draftVersion: 4 }
    expect(shouldClearSteerDraft(whitespaceOwner, true, '  hello  ', 4)).toBe(true)
    expect(shouldClearSteerDraft(whitespaceOwner, true, 'hello', 4)).toBe(false)
  })

  it('does not submit steer Enter while an IME composition is active', () => {
    expect(shouldSubmitSteerKey('Enter', false, false, false, 'go')).toBe(true)
    expect(shouldSubmitSteerKey('Enter', false, true, false, 'go')).toBe(false)
    expect(shouldSubmitSteerKey('Enter', false, false, true, 'go')).toBe(false)
  })

  it('allows controls only for current top-level async runs', () => {
    const status = normalizeSubagentStatus({
      available: true,
      capabilities: { methods: ['stop', 'steer'] },
      asyncRuns: [{ id: 'run-1', label: 'worker', state: 'running', children: [{ id: 'child-1', label: 'child', state: 'running' }] }],
      fleet: { entries: [{ agent: 'display-only', startedAt: 10 }] },
    })
    expect(subagentCanControl(status, 'run-1', 'stop')).toBe(true)
    expect(subagentCanControl(status, 'child-1', 'stop')).toBe(false)
    expect(subagentCanControl(status, 'display-only', 'stop')).toBe(false)
    expect(subagentCanControl(status, 'run-1', 'resume')).toBe(false)
    expect(subagentCanControl({ ...status, available: false }, 'run-1', 'stop')).toBe(false)
    expect(subagentCanControl({ ...status, stale: true }, 'run-1', 'interrupt')).toBe(false)
    expect(subagentCanLoadTranscript(status, 'run-1')).toBe(false)
    expect(subagentCanLoadTranscript({ ...status, capabilities: { ...status.capabilities, status: true } }, 'run-1')).toBe(true)
    expect(subagentCanLoadTranscript({ ...status, available: false, capabilities: { ...status.capabilities, status: true } }, 'run-1')).toBe(false)
  })
})
