import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TabBrowserStateStore } from './tabBrowserStateStore'
import { emptyBrowserState } from '../shared/tabBrowserState'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'amber-browser-state-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('TabBrowserStateStore', () => {
  it('atomically round-trips a private state file', async () => {
    const store = new TabBrowserStateStore(dir)
    const state = emptyBrowserState(1); state.revision = 2
    await store.save(state)
    expect((await store.load()).revision).toBe(2)
    expect(JSON.parse(await readFile(join(dir, 'browser-state.json'), 'utf8')).revision).toBe(2)
    if (process.platform !== 'win32') expect((await lstat(join(dir, 'browser-state.json'))).mode & 0o777).toBe(0o600)
  })

  it('returns an empty state when the file is malformed', async () => {
    const store = new TabBrowserStateStore(dir)
    await writeFile(join(dir, 'browser-state.json'), '{bad')
    expect((await store.load()).revision).toBe(0)
  })
})
