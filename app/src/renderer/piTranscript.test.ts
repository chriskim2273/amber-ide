import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { markdownBlocks, PiTranscript, safeMarkdownHref } from './PiTranscript'
import { mergePiTimeline, normalizeSubagentStatus, reducePiView, initialPiViewState } from './piModel'

describe('Pi transcript presentation', () => {
  it('keeps Markdown safe while supporting readable blocks and safe links', () => {
    const blocks = markdownBlocks('# Heading\n\n> quoted\n\n```ts\nconst x = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'code'])
    expect(safeMarkdownHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeMarkdownHref('javascript:alert(1)')).toBeNull()
    expect(safeMarkdownHref('/local/file')).toBeNull()
  })

  it('places a tool card in the assistant turn without duplicating it globally', () => {
    const items = mergePiTimeline([
      { role: 'assistant', content: [{ type: 'toolCall', toolCallId: 'call-1', name: 'read', arguments: {} }] },
    ], {
      'call-1': { id: 'call-1', name: 'read', running: false, result: 'ok' },
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'message', tools: [{ id: 'call-1' }] })
  })

  it('turns off live announcements for the streaming transcript region', () => {
    const html = renderToStaticMarkup(createElement(PiTranscript, {
      messages: [{ role: 'assistant', content: 'streaming text' }], liveMessage: null, tools: {}, follow: true,
      onFollowChange: () => {},
    }))
    expect(html).toContain('role="log" aria-live="off"')
  })

  it('retains a command error across unrelated streamed events', () => {
    const failed = reducePiView(initialPiViewState, {
      kind: 'PiEvent', name: 'pi', seq: 1,
      event: { kind: 'command_result', requestId: 'r1', command: 'SubagentControl', success: false, error: 'not controllable' },
    })
    const next = reducePiView(failed, {
      kind: 'PiEvent', name: 'pi', seq: 2,
      event: { kind: 'message_update', message: { role: 'assistant', content: 'still streaming' } },
    })
    expect(next.error).toBe('not controllable')
  })

  it('normalizes only top-level async IDs as controllable', () => {
    const status = normalizeSubagentStatus({
      available: true,
      capabilities: { methods: ['stop'] },
      asyncRuns: [{ id: 'run-1', label: 'worker', state: 'running', children: [{ id: 'child-1', label: 'child', state: 'running' }] }],
      fleet: { entries: [{ agent: 'fleet-1', startedAt: 1 }] },
    })
    expect(status.asyncRuns[0]!.id).toBe('run-1')
    expect(status.asyncRuns[0]!.children?.[0]?.id).toBe('child-1')
    expect(status.fleet.entries[0]!.agent).toBe('fleet-1')
  })
})
