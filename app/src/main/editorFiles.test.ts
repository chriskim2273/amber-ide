import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readEditorFile,
  saveEditorFile,
  isEditorPaneId,
  draftPath,
  writeDraft,
  readDraft,
  clearDraft,
  inlineImages,
} from './editorFiles'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'amber-editor-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('readEditorFile', () => {
  it('reads text + mtimeMs', async () => {
    const p = join(dir, 'a.json')
    await writeFile(p, '{"a":1}')
    const r = await readEditorFile(p)
    expect(r).toEqual({ text: '{"a":1}', mtimeMs: (await stat(p)).mtimeMs })
  })

  it('rejects a relative path', async () => {
    expect(await readEditorFile('a.json')).toEqual({ error: 'path must be absolute' })
  })

  it('rejects a missing file', async () => {
    const r = await readEditorFile(join(dir, 'nope.txt'))
    expect('error' in r).toBe(true)
  })

  it('rejects a directory', async () => {
    expect(await readEditorFile(dir)).toEqual({ error: 'not a regular file' })
  })

  it('rejects a file over the 8 MiB cap', async () => {
    const p = join(dir, 'big.txt')
    await writeFile(p, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
    expect(await readEditorFile(p)).toEqual({ error: 'too large' })
  })

  it('rejects a binary file (NUL in the first 8 KiB)', async () => {
    const p = join(dir, 'bin')
    await writeFile(p, Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0]), Buffer.alloc(100, 0x61)]))
    expect(await readEditorFile(p)).toEqual({ error: 'binary file' })
  })

  it('accepts a NUL past the first 8 KiB sniff window', async () => {
    const p = join(dir, 'late-nul')
    await writeFile(p, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))
    const r = await readEditorFile(p)
    expect('text' in r).toBe(true)
  })
})

describe('saveEditorFile', () => {
  it('writes atomically and returns the new mtime, leaving no tmp behind', async () => {
    const p = join(dir, 'out.md')
    const r = await saveEditorFile(p, '# hi', null)
    expect(r).toEqual({ mtimeMs: (await stat(p)).mtimeMs })
    expect(await readFile(p, 'utf8')).toBe('# hi')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('null expected mtime never conflicts (first save / overwrite)', async () => {
    const p = join(dir, 'out.md')
    await writeFile(p, 'old')
    const r = await saveEditorFile(p, 'new', null)
    expect('mtimeMs' in r && !('conflict' in r)).toBe(true)
    expect(await readFile(p, 'utf8')).toBe('new')
  })

  it('detects an external change and does NOT write', async () => {
    const p = join(dir, 'out.md')
    await writeFile(p, 'old')
    const disk = (await stat(p)).mtimeMs
    const r = await saveEditorFile(p, 'mine', disk - 5000)
    expect(r).toEqual({ conflict: true, mtimeMs: disk })
    expect(await readFile(p, 'utf8')).toBe('old')
  })

  it('writes when the expected mtime matches', async () => {
    const p = join(dir, 'out.md')
    await writeFile(p, 'old')
    const r = await saveEditorFile(p, 'mine', (await stat(p)).mtimeMs)
    expect('conflict' in r).toBe(false)
    expect(await readFile(p, 'utf8')).toBe('mine')
  })

  it('recreates a deleted file instead of reporting a conflict', async () => {
    const p = join(dir, 'gone.md')
    const r = await saveEditorFile(p, 'back', 123456)
    expect('conflict' in r).toBe(false)
    expect(await readFile(p, 'utf8')).toBe('back')
  })

  it('rejects a relative path', async () => {
    expect(await saveEditorFile('out.md', 'x', null)).toEqual({ error: 'path must be absolute' })
  })

  it('returns an error instead of throwing on an unwritable path', async () => {
    const r = await saveEditorFile(join(dir, 'no-such-dir', 'x.md'), 'x', null)
    expect('error' in r).toBe(true)
  })
})

describe('isEditorPaneId', () => {
  it('accepts the editor-<ws>-<tab>-<ord>-<id> grammar', () => {
    expect(isEditorPaneId('editor-0-0-0-abc123')).toBe(true)
    expect(isEditorPaneId('editor-12-3-4-x')).toBe(true)
  })

  it('rejects traversal attempts that keep the prefix', () => {
    expect(isEditorPaneId('editor-0-0-0-../../etc/passwd')).toBe(false)
    expect(isEditorPaneId('editor-0-0-0-..')).toBe(false)
    expect(isEditorPaneId('editor-0-0-0-a/b')).toBe(false)
    expect(isEditorPaneId('editor-0-0-0-a\\b')).toBe(false)
  })

  it('rejects non-editor ids', () => {
    expect(isEditorPaneId('amber-0-0-0-abc')).toBe(false)
    expect(isEditorPaneId('browser-0-0-0-abc')).toBe(false)
    expect(isEditorPaneId('../x')).toBe(false)
    expect(isEditorPaneId('')).toBe(false)
  })
})

describe('drafts', () => {
  it('round-trips write → read → clear', async () => {
    const id = 'editor-1-2-3-abc'
    expect(await readDraft(dir, id)).toBe(null)
    await writeDraft(dir, id, 'unsaved work')
    expect(await readDraft(dir, id)).toBe('unsaved work')
    await clearDraft(dir, id)
    expect(await readDraft(dir, id)).toBe(null)
  })

  it('creates the drafts dir and leaves no tmp file', async () => {
    const drafts = join(dir, 'nested', 'drafts')
    await writeDraft(drafts, 'editor-0-0-0-a', 'x')
    expect(await readFile(join(drafts, 'editor-0-0-0-a.txt'), 'utf8')).toBe('x')
    expect((await readdir(drafts)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('clearing a missing draft is a no-op', async () => {
    await expect(clearDraft(dir, 'editor-0-0-0-nope')).resolves.toBeUndefined()
  })

  it('refuses a traversal paneId — nothing is written outside the drafts dir', async () => {
    const drafts = join(dir, 'drafts')
    await mkdir(drafts, { recursive: true })
    const evil = 'editor-0-0-0-../../pwned'
    expect(draftPath(drafts, evil)).toBe(null)
    await writeDraft(drafts, evil, 'boom')
    expect(await readDraft(drafts, evil)).toBe(null)
    await expect(readdir(dir)).resolves.toEqual(['drafts'])
  })

  it('draftPath stays inside the drafts dir for a valid id', () => {
    expect(draftPath('/s/drafts', 'editor-0-0-0-a')).toBe('/s/drafts/editor-0-0-0-a.txt')
  })
})

describe('inlineImages', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

  it('inlines a relative local image resolved against mdDir', async () => {
    await writeFile(join(dir, 'a.png'), png)
    const r = await inlineImages(dir, '<p><img src="a.png" alt="x"></p>')
    expect(r.html).toBe(`<p><img src="data:image/png;base64,${png.toString('base64')}" alt="x"></p>`)
  })

  it('inlines an absolute local image and single-quoted srcs', async () => {
    const p = join(dir, 'b.jpg')
    await writeFile(p, png)
    const r = await inlineImages(dir, `<img src='${p}'>`)
    expect(r.html).toContain('data:image/jpeg;base64,')
  })

  it('keeps svg as image/svg+xml', async () => {
    await writeFile(join(dir, 'c.svg'), '<svg/>')
    const r = await inlineImages(dir, '<img src="c.svg">')
    expect(r.html).toContain('data:image/svg+xml;base64,')
  })

  it('never touches remote or data srcs', async () => {
    const html = '<img src="https://x.test/a.png"><img src="http://x.test/b.png"><img src="data:image/png;base64,AA">'
    expect((await inlineImages(dir, html)).html).toBe(html)
  })

  it('leaves a missing file as-is', async () => {
    const html = '<img src="nope.png">'
    expect((await inlineImages(dir, html)).html).toBe(html)
  })

  it('leaves a non-image extension as-is (traversal targets are not images)', async () => {
    const html = '<img src="../../etc/passwd">'
    expect((await inlineImages(dir, html)).html).toBe(html)
  })

  it('inlines an image outside mdDir (same reach as Open), still capped', async () => {
    const outside = join(dir, 'assets')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'd.png'), png)
    const sub = join(dir, 'doc')
    await mkdir(sub, { recursive: true })
    const r = await inlineImages(sub, '<img src="../assets/d.png">')
    expect(r.html).toContain('data:image/png;base64,')
  })

  it('leaves an image over the 2 MiB cap as-is', async () => {
    await writeFile(join(dir, 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 1, 1))
    const html = '<img src="big.png">'
    expect((await inlineImages(dir, html)).html).toBe(html)
  })

  it('inlines at most 10 images per document', async () => {
    await writeFile(join(dir, 'a.png'), png)
    const html = '<img src="a.png">'.repeat(12)
    const out = (await inlineImages(dir, html)).html
    expect(out.split('data:image/png').length - 1).toBe(10)
    expect(out.split('src="a.png"').length - 1).toBe(2)
  })

  it('leaves a directory src as-is', async () => {
    await mkdir(join(dir, 'sub.png'), { recursive: true })
    const html = '<img src="sub.png">'
    expect((await inlineImages(dir, html)).html).toBe(html)
  })
})
