import { describe, expect, it } from 'vitest'
import { parseBrowserToolAction } from './browserToolProtocol'

const page = { pageIncarnation: 'page-1', expectedGeneration: 3 }

describe('browser tool protocol', () => {
  it('parses the bounded phase-A action surface', () => {
    expect(parseBrowserToolAction({ type: 'snapshot', ...page, limits: { maxDepth: 10, maxNodes: 100, maxBytes: 4096 } })).toMatchObject({ type: 'snapshot', limits: { maxDepth: 10 } })
    expect(parseBrowserToolAction({ type: 'find', ...page, snapshotId: 'snap-1', query: { text: 'button', role: 'button', limit: 5 } }).type).toBe('find')
    expect(parseBrowserToolAction({ type: 'inspect', ...page, target: { snapshotId: 'snap-1', ref: 'n1' } }).type).toBe('inspect')
    expect(parseBrowserToolAction({ type: 'screenshot', ...page, fullPage: false }).type).toBe('screenshot')
    expect(parseBrowserToolAction({ type: 'console', ...page, cursor: '0', levels: ['error', 'warning'], limit: 20 }).type).toBe('console')
    expect(parseBrowserToolAction({ type: 'network', ...page, cursor: '0', limit: 20 }).type).toBe('network')
    expect(parseBrowserToolAction({ type: 'wait', ...page, condition: { kind: 'text', value: 'Ready' }, timeoutMs: 5000 }).type).toBe('wait')
    expect(parseBrowserToolAction({ type: 'history', ...page, direction: 'back' }).type).toBe('history')
    expect(parseBrowserToolAction({ type: 'reload', ...page, ignoreCache: true }).type).toBe('reload')
    expect(parseBrowserToolAction({ type: 'setViewport', ...page, viewport: { width: 390, height: 844, deviceScaleFactor: 2 } }).type).toBe('setViewport')
  })

  it('rejects raw debugger/script/storage/header surfaces and every unbounded field', () => {
    for (const action of [
      { type: 'cdp', method: 'Runtime.evaluate' }, { type: 'evaluate', script: 'document.cookie' },
      { type: 'cookies' }, { type: 'storage' }, { type: 'headers' },
      { type: 'snapshot', ...page, limits: { maxDepth: 21 } },
      { type: 'find', ...page, snapshotId: 'snap-1', query: { text: 'x'.repeat(4097) } },
      { type: 'find', ...page, snapshotId: 'snap-1', query: { regex: '(a+)+$' } },
      { type: 'wait', ...page, condition: { kind: 'text', value: 'x' }, timeoutMs: 120001 },
      { type: 'setViewport', ...page, viewport: { width: 4097, height: 800 } },
      { type: 'setViewport', ...page, viewport: { width: 800, height: 600, deviceScaleFactor: Number.NaN } },
      { type: 'screenshot', ...page, path: '/tmp/leak.png' },
      { type: 'console', ...page, levels: new Array(20).fill('error') },
      { type: 'console', ...page, cursor: '9999999999999999' },
    ]) expect(() => parseBrowserToolAction(action)).toThrow('INVALID_REQUEST')
  })

  it('requires exact incarnation/generation and rejects unknown nested keys', () => {
    expect(() => parseBrowserToolAction({ type: 'snapshot' })).toThrow('INVALID_REQUEST')
    expect(() => parseBrowserToolAction({ type: 'inspect', ...page, target: { snapshotId: 'snap', ref: 'n1', selector: 'body' } })).toThrow('INVALID_REQUEST')
    expect(() => parseBrowserToolAction({ type: 'find', ...page, snapshotId: 'snap', query: { role: 'button', secret: 'x' } })).toThrow('INVALID_REQUEST')
  })
})
