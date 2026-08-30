import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProductivityFile, saveProductivityFile, readProjectProfile, writeCheckpoint, readCheckpoint, deleteCheckpoint, listCheckpoints, contained } from './productivityIO'
import { serializeCheckpoint } from '../shared/checkpoint'
import type { WorkspaceDoc } from '../shared/workspaceFile'

const doc: WorkspaceDoc = { version: 1, scope: 'one', workspaces: [{ tabs: [] }] }

describe('productivity IO', () => {
  it('uses exact-content CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amber-productivity-'))
    const path = join(root, 'productivity.json')
    expect(await loadProductivityFile(path)).toEqual({ text: null, version: null })
    expect(await saveProductivityFile(path, '{"version":1}', null)).toEqual({ ok: true, version: '{"version":1}' })
    expect(await saveProductivityFile(path, 'new', null)).toEqual({ conflict: true, text: '{"version":1}', version: '{"version":1}' })
  })

  it('validates project containment and real directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amber-project-'))
    await mkdir(join(root, 'app'))
    await writeFile(join(root, '.amber.toml'), 'version = 1\n[[pane]]\nkind = "shell"\ncwd = "app"\n')
    const result = await readProjectProfile(root)
    expect('profile' in result && result.resolvedCwds[0]).toBe(join(root, 'app'))
    expect(contained('/tmp/root/app', '/tmp/root/app2')).toBe(false)
  })

  it('contains checkpoint paths and roundtrips valid files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amber-checkpoint-'))
    const id = 'checkpoint-123'
    const text = serializeCheckpoint(doc, { id, name: 'manual', createdAt: 10, scope: 'one', automatic: false })
    await writeCheckpoint(root, id, text)
    expect(text.startsWith('{"checkpoint":')).toBe(true)
    expect(await readCheckpoint(root, id)).toBe(text)
    expect((await listCheckpoints(root))[0]?.id).toBe(id)
    await deleteCheckpoint(root, id)
    expect(await listCheckpoints(root)).toEqual([])
    await expect(writeCheckpoint(root, '../escape', text)).rejects.toThrow(/id/)
  })

  it('lists bounded metadata without parsing the workspace body and rejects symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amber-checkpoint-meta-'))
    const dir = join(root, 'checkpoints')
    await mkdir(dir)
    const meta = { id: 'checkpoint-meta', name: 'metadata only', createdAt: 20, scope: 'one' as const, automatic: false }
    await writeFile(join(dir, 'checkpoint-meta.amberws'), JSON.stringify({ checkpoint: meta, version: 1, scope: 'one', workspaces: 'not a workspace' }))
    expect((await listCheckpoints(root))[0]).toMatchObject(meta)
    await expect(readCheckpoint(root, meta.id)).rejects.toThrow(/workspace/)
    const outside = join(root, 'outside.amberws')
    await writeFile(outside, serializeCheckpoint(doc, { ...meta, id: 'checkpoint-link' }))
    await symlink(outside, join(dir, 'checkpoint-link.amberws'))
    expect((await listCheckpoints(root)).map((entry) => entry.id)).not.toContain('checkpoint-link')
    await expect(readCheckpoint(root, 'checkpoint-link')).rejects.toThrow(/regular file/)
  })
})
