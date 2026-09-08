import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { markdownBlocks, PiTranscript, SafeMarkdown, safeMarkdownHref } from './PiTranscript'
import { mergePiTimeline, normalizeSubagentStatus, reducePiView, initialPiViewState } from './piModel'

describe('Pi transcript presentation', () => {
  it('keeps Markdown safe while supporting readable blocks and safe links', () => {
    const blocks = markdownBlocks('# Heading\n\n> quoted\n\n```ts\nconst x = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'code'])
    expect(safeMarkdownHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeMarkdownHref('javascript:alert(1)')).toBeNull()
    expect(safeMarkdownHref('/local/file')).toBeNull()
  })

  it('hydrates real persisted tool messages and renders one reconciled failed tool card', () => {
    const snapshot = reducePiView(initialPiViewState, {
      kind: 'PiEvent', name: 'pi', seq: 1,
      event: {
        kind: 'snapshot', sessionId: 'pi-session-1', entries: [
          { type: 'session', id: 'header', parentId: null, timestamp: '2026-09-07T00:00:00.000Z' },
          { type: 'message', id: 'assistant-1', parentId: 'header', timestamp: '2026-09-07T00:00:01.000Z', message: {
            role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: 'secret.txt' } }],
          } },
          { type: 'message', id: 'result-1', parentId: 'assistant-1', timestamp: '2026-09-07T00:00:02.000Z', message: {
            role: 'toolResult', toolCallId: 'call-1', toolName: 'read_file', isError: true,
            content: [{ type: 'text', text: 'permission denied' }],
          } },
        ],
      },
    })
    expect(snapshot.tools['call-1']).toMatchObject({ id: 'call-1', name: 'read_file', running: false, error: true })
    expect(snapshot.tools['call-1']!.result).toEqual([{ type: 'text', text: 'permission denied' }])
    const html = renderToStaticMarkup(createElement(PiTranscript, {
      messages: snapshot.messages, liveMessage: snapshot.liveMessage, tools: snapshot.tools, follow: true,
      onFollowChange: () => {},
    }))
    expect((html.match(/class="pi-tool-card/g) ?? [])).toHaveLength(1)
    expect(html).toContain('failed')
    expect(html).not.toContain('pi-message toolResult')
  })

  it('renders tables and preserves ordered and unordered list semantics safely', () => {
    const value = '| Name | Result |\n| --- | :---: |\n| Alpha | ok |\n\n3. First\n4. Second\n\n- One\n- Two'
    const blocks = markdownBlocks(value)
    expect(blocks).toMatchObject([
      { kind: 'table', headers: ['Name', 'Result'], rows: [['Alpha', 'ok']] },
      { kind: 'list', ordered: true, start: 3, items: ['First', 'Second'] },
      { kind: 'list', ordered: false, items: ['One', 'Two'] },
    ])
    const html = renderToStaticMarkup(createElement(SafeMarkdown, { value }))
    expect(html).toContain('<table')
    expect(html).toContain('<th scope="col">')
    expect(html).toContain('Name')
    expect(html).toContain('<ol start="3">')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).not.toContain('class="pi-list-item"')
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
