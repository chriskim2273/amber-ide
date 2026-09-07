import { describe, expect, it } from 'vitest'
import { initialPiViewState, messagesFromEntries, reducePiView } from './piModel'

describe('Pi semantic model', () => {
  it('hydrates from a bounded session snapshot and replaces it authoritatively', () => {
    const next = reducePiView(initialPiViewState, {
      kind: 'PiEvent', name: 'pi', seq: 4,
      event: {
        kind: 'snapshot', idle: false, pending: true, thinkingLevel: 'high',
        model: { id: 'model' }, contextUsage: { percent: 42 },
        entries: [
          { type: 'session', id: 'header' },
          { type: 'message', message: { role: 'user', content: 'hello' } },
        ],
      },
    })
    expect(next.available).toBe(true)
    expect(next.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(next.idle).toBe(false)
    expect(next.thinkingLevel).toBe('high')
    expect(next.contextUsage).toEqual({ percent: 42 })
  })

  it('reduces message streaming and ignores duplicate out-of-order deltas', () => {
    const start = reducePiView(initialPiViewState, {
      kind: 'PiEvent', name: 'pi', seq: 1,
      event: { kind: 'message_start', message: { role: 'assistant', content: [] } },
    })
    const update = reducePiView(start, {
      kind: 'PiEvent', name: 'pi', seq: 2,
      event: { kind: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    })
    expect(update.liveMessage).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] })
    expect(reducePiView(update, {
      kind: 'PiEvent', name: 'pi', seq: 2,
      event: { kind: 'agent_settled' },
    })).toBe(update)
    const end = reducePiView(update, {
      kind: 'PiEvent', name: 'pi', seq: 3,
      event: { kind: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] } },
    })
    expect(end.liveMessage).toBeNull()
    expect(end.messages).toHaveLength(1)
  })

  it('tracks tool lifecycle and terminal-owned blocking UI', () => {
    const start = reducePiView(initialPiViewState, {
      kind: 'PiEvent', name: 'pi', seq: 1,
      event: { kind: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a' } },
    })
    const end = reducePiView(start, {
      kind: 'PiEvent', name: 'pi', seq: 2,
      event: { kind: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'ok', isError: false },
    })
    expect(end.tools['t1']).toMatchObject({ running: false, result: 'ok' })
    const waiting = reducePiView(end, {
      kind: 'PiEvent', name: 'pi', seq: 3,
      event: { kind: 'ui_prompt_start', eventKind: 'confirm', title: 'Allow?' },
    })
    expect(waiting.awaitingUi).toEqual({ kind: 'confirm', title: 'Allow?' })
  })

  it('resets sequence acceptance after bridge loss and accepts restart snapshots', () => {
    const old = { ...initialPiViewState, available: true, lastSeq: 100 }
    const offline = reducePiView(old, { kind: 'PiBridgeStatus', name: 'pi', available: false })
    expect(offline.lastSeq).toBe(0)
    const restarted = reducePiView(offline, {
      kind: 'PiEvent', name: 'pi', seq: 1, event: { kind: 'snapshot', entries: [], idle: true },
    })
    expect(restarted.available).toBe(true)
  })

  it('extracts only message entries from session history', () => {
    expect(messagesFromEntries([null, { type: 'custom' }, { type: 'message', message: { role: 'user' } }]))
      .toEqual([{ role: 'user' }])
  })
})
