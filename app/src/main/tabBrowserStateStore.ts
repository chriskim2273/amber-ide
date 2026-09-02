import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { emptyBrowserState, parseBrowserState, type BrowserStateFile } from '../shared/tabBrowserState'

export interface BrowserStateLockedIo {
  load(): Promise<BrowserStateFile>
  save(state: BrowserStateFile): Promise<void>
}

export class TabBrowserStateStore {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly root: string) { this.path = join(root, 'browser-state.json') }

  withLock<T>(operation: (io: BrowserStateLockedIo) => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void; let reject!: (reason: unknown) => void
    const result = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    const run = this.queue.then(async () => {
      try { resolve(await operation({ load: () => this.loadDirect(), save: (state) => this.saveDirect(state) })) }
      catch (error) { reject(error) }
    })
    this.queue = run.catch(() => {})
    return result
  }

  load(): Promise<BrowserStateFile> { return this.withLock((io) => io.load()) }
  save(state: BrowserStateFile): Promise<void> { return this.withLock((io) => io.save(state)) }
  update(mutator: (current: BrowserStateFile) => BrowserStateFile): Promise<void> {
    return this.withLock(async (io) => { const current = await io.load(); await io.save(mutator(current)) })
  }

  private async loadDirect(): Promise<BrowserStateFile> {
    try { return parseBrowserState(await readFile(this.path, 'utf8')) }
    catch { return emptyBrowserState() }
  }

  private async saveDirect(state: BrowserStateFile): Promise<void> {
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
