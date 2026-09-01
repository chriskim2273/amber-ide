import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { emptyBrowserState, parseBrowserState, type BrowserStateFile } from '../shared/tabBrowserState'

export class TabBrowserStateStore {
  readonly path: string
  constructor(private readonly root: string) { this.path = join(root, 'browser-state.json') }

  async load(): Promise<BrowserStateFile> {
    try { return parseBrowserState(await readFile(this.path, 'utf8')) }
    catch { return emptyBrowserState() }
  }

  async save(state: BrowserStateFile): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(tmp, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close(); handle = null
      await rename(tmp, this.path)
      if (process.platform !== 'win32') {
        const parent = await open(this.root, 'r')
        try { await parent.sync() } finally { await parent.close() }
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(tmp).catch(() => {})
      throw error
    }
  }
}
