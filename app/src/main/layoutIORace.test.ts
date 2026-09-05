import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { openMock, setMutation, getMutation } = vi.hoisted(() => {
  let mutation: ((path: string, fs: typeof import('node:fs/promises')) => Promise<void>) | undefined
  return {
    openMock: vi.fn(),
    setMutation: (next: typeof mutation): void => { mutation = next },
    getMutation: (): typeof mutation => mutation,
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  openMock.mockImplementation(async (...args: unknown[]) => {
    const handle = await (actual.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(...args)
    const mutation = getMutation()
    if (mutation && typeof args[0] === 'string' && String(args[0]).endsWith('ui-layout.json')) {
      const originalRead = handle.read.bind(handle)
      let first = true
      handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
        if (first) {
          first = false
          await (mutation as (path: string, fs: typeof import('node:fs/promises')) => Promise<void>)(String(args[0]), actual)
        }
        return originalRead(...readArgs)
      }
    }
    return handle
  })
  return { ...actual, open: openMock }
})

const { loadLayoutFile } = await import('./layoutIO')

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amber-layoutio-race-'))
  path = join(dir, 'ui-layout.json')
  openMock.mockClear()
  setMutation(undefined)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('layout ingress mutation races', () => {
  it('rejects an in-place truncate during descriptor read', async () => {
    await writeFile(path, '{"stable":true}')
    setMutation(async (candidate, fs) => { await fs.truncate(candidate, 0) })
    await expect(loadLayoutFile(path)).resolves.toMatchObject({ text: null, error: 'LAYOUT_FILE_CHANGED' })
  })

  it('rejects an append during descriptor read, even below the byte cap', async () => {
    await writeFile(path, '{"stable":true}')
    setMutation(async (candidate, fs) => { await fs.appendFile(candidate, 'x') })
    await expect(loadLayoutFile(path)).resolves.toMatchObject({ text: null, error: 'LAYOUT_FILE_CHANGED' })
  })

  it('rejects truncate-and-regrow to the original size during descriptor read', async () => {
    const stable = '{"stable":true}'
    await writeFile(path, stable)
    setMutation(async (candidate, fs) => {
      await fs.truncate(candidate, 0)
      await fs.writeFile(candidate, stable)
    })
    await expect(loadLayoutFile(path)).resolves.toMatchObject({ text: null, error: 'LAYOUT_FILE_CHANGED' })
  })

  it('rejects a symlink swapped in after the safe descriptor was opened', async () => {
    const target = join(dir, 'target.json')
    await writeFile(path, '{"stable":true}')
    await writeFile(target, '{"attacker":true}')
    setMutation(async (candidate, fs) => {
      await fs.rename(candidate, join(dir, 'original.json'))
      await fs.symlink(target, candidate)
    })
    const result = await loadLayoutFile(path)
    expect(result.text).toBeNull()
    expect(['LAYOUT_FILE_CHANGED', 'LAYOUT_SYMLINK']).toContain(result.error)
  })
})
