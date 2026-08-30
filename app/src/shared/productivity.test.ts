import { describe, expect, it } from 'vitest'
import { emptyProductivity, parseProductivity, replayProductivity, serializeProductivity } from './productivity'
import { parseProjectProfile } from './projectProfile'
import { parseCheckpoint, serializeCheckpoint } from './checkpoint'
import { parseHandoff, serializeHandoff } from './handoff'
import type { WorkspaceDoc } from './workspaceFile'

const doc: WorkspaceDoc = { version: 1, scope: 'one', workspaces: [{ tabs: [] }] }

describe('productivity schemas', () => {
  it('defaults malformed files and shape-guards bounded metadata', () => {
    expect(parseProductivity('bad')).toEqual(emptyProductivity())
    const value = emptyProductivity()
    value.bookmarks['s'] = Array.from({ length: 110 }, (_, i) => ({
      id: `bookmark-${String(i).padStart(3, '0')}`, createdAt: i,
      label: 'l'.repeat(130), excerpt: 'e'.repeat(600),
    }))
    const parsed = parseProductivity(serializeProductivity(value))
    expect(parsed.bookmarks['s']).toHaveLength(100)
    expect(parsed.bookmarks['s']![0]!.label).toHaveLength(120)
    expect(parsed.bookmarks['s']![0]!.excerpt).toHaveLength(500)
  })

  it('replays queued local operations over a fresh CAS-conflict remote', () => {
    const remote = emptyProductivity()
    remote.templates.push({ id: 'template-remote', name: 'remote', createdAt: 1, doc })
    const rebased = replayProductivity(remote, [
      (file) => ({ ...file, notifications: { ...file.notifications, activity: true } }),
      (file) => ({ ...file, bookmarks: { ...file.bookmarks, session: [{ id: 'bookmark-local', createdAt: 2, label: 'local', excerpt: 'needle' }] } }),
    ])
    expect(rebased.templates[0]?.name).toBe('remote')
    expect(rebased.notifications.activity).toBe(true)
    expect(rebased.bookmarks['session']?.[0]?.label).toBe('local')
  })

  it('parses the strict non-executable project profile', () => {
    expect(parseProjectProfile(`version = 1\nname = "web"\n[[pane]]\nkind = "shell"\ncwd = "."\n[[pane]]\nkind = "codex"\ncwd = "app"\ndirection = "v"`)).toEqual({
      version: 1, name: 'web', panes: [
        { kind: 'shell', cwd: '.', direction: 'h' },
        { kind: 'codex', cwd: 'app', direction: 'v' },
      ],
    })
    for (const source of [
      `version = 1\ncommand = "rm -rf /"\n[[pane]]\nkind = "shell"\ncwd = "."`,
      `version = 1\n[[pane]]\nkind = "shell"\ncwd = "../escape"`,
      `version = 1\n[[pane]]\nkind = "browser"\ncwd = "."`,
      `version = 2\n[[pane]]\nkind = "shell"\ncwd = "."`,
    ]) expect(() => parseProjectProfile(source)).toThrow()
  })

  it('keeps checkpoints valid as ordinary workspace documents', () => {
    const text = serializeCheckpoint(doc, { id: 'checkpoint-123', name: 'before replace', createdAt: 5, scope: 'one', automatic: true })
    const parsed = parseCheckpoint(text)
    expect(parsed.checkpoint.name).toBe('before replace')
    expect(parsed.workspaces).toEqual(doc.workspaces)
  })

  it('serializes bounded handoffs without a reusable daemon name', () => {
    const text = serializeHandoff({
      version: 1, exportedAt: 10,
      session: { kind: 'shell', cwd: '/tmp', slot: 2, title: 'work' },
      scrollback: 'YWJj', bookmarks: [],
    })
    const parsed = parseHandoff(text)
    expect(parsed.session).toEqual({ kind: 'shell', cwd: '/tmp', slot: 2, title: 'work' })
    expect(text).not.toContain('amber-1-1')
    for (const corrupt of [
      { ...parsed, scrollback: 'not base64!' },
      { ...parsed, session: { ...parsed.session, kind: 'x'.repeat(33) } },
      { ...parsed, session: { ...parsed.session, cwd: 'x'.repeat(4097) } },
      { ...parsed, session: { ...parsed.session, slot: -1 } },
    ]) expect(() => parseHandoff(JSON.stringify(corrupt))).toThrow()
  })
})
