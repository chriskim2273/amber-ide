import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSafeTextFile, readSafeTextFileSync } from './safeFileReader'

const dirs: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('readSafeTextFile', () => {
  it('decodes only stable regular-file UTF-8 and rejects replacement-byte JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-safe-reader-')); dirs.push(dir)
    const path = join(dir, 'state.json')
    await writeFile(path, Buffer.from('{"title":"ok"}', 'utf8'))
    await expect(readSafeTextFile(path, { maxBytes: 4096 })).resolves.toBe('{"title":"ok"}')
    await writeFile(path, Buffer.from([0x7b, 0x22, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]))
    await expect(readSafeTextFile(path, { maxBytes: 4096 })).rejects.toMatchObject({ code: 'INVALID_UTF8' })
  })

  it('rejects symlinks and non-regular files without reading through them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-safe-reader-')); dirs.push(dir)
    const target = join(dir, 'target'), link = join(dir, 'link')
    await writeFile(target, 'safe')
    await symlink(target, link)
    await expect(readSafeTextFile(link, { maxBytes: 4096 })).rejects.toMatchObject({ code: 'SYMLINK' })
    if (process.platform !== 'win32') {
      const { open, unlink } = await import('node:fs/promises')
      const fifo = join(dir, 'fifo')
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => execFile('mkfifo', [fifo], (error) => error ? reject(error) : resolve()))
      await expect(Promise.race([
        readSafeTextFile(fifo, { maxBytes: 4096 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('FIFO_READ_BLOCKED')), 500)),
      ])).rejects.toMatchObject({ code: 'NOT_REGULAR' })
      await unlink(fifo)
      void open
    }
  })

  it('uses the same bounded no-follow contract for synchronous startup markers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-safe-reader-')); dirs.push(dir)
    const path = join(dir, 'marker')
    await writeFile(path, 'electron=43 kernel=7\n')
    expect(readSafeTextFileSync(path, { maxBytes: 256 })).toBe('electron=43 kernel=7\n')
    await writeFile(path, Buffer.alloc(257, 0x78))
    expect(() => readSafeTextFileSync(path, { maxBytes: 256 })).toThrow('FILE_TOO_LARGE')
    await writeFile(path, Buffer.from([0xc3, 0x28]))
    expect(() => readSafeTextFileSync(path, { maxBytes: 256 })).toThrow('INVALID_UTF8')
    if (process.platform !== 'win32') {
      const { execFile } = await import('node:child_process')
      const { unlink } = await import('node:fs/promises')
      await unlink(path)
      await new Promise<void>((resolve, reject) => execFile('mkfifo', [path], (error) => error ? reject(error) : resolve()))
      expect(() => readSafeTextFileSync(path, { maxBytes: 256 })).toThrow('NOT_REGULAR')
    }
  })

  it('enforces byte limits before returning text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-safe-reader-')); dirs.push(dir)
    const path = join(dir, 'large')
    await writeFile(path, '0123456789')
    await expect(readSafeTextFile(path, { maxBytes: 9 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('checks ownership when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amber-safe-reader-')); dirs.push(dir)
    const path = join(dir, 'owned')
    await writeFile(path, 'ok')
    const owner = (await lstat(path)).uid
    if (owner !== undefined) {
      await expect(readSafeTextFile(path, { maxBytes: 4096, owner: owner + 1 })).rejects.toMatchObject({ code: 'WRONG_OWNER' })
      await expect(readSafeTextFile(path, { maxBytes: 4096, owner })).resolves.toBe('ok')
    }
  })
})
