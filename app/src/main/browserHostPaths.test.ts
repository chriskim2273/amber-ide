import { chmod, lstat, mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { browserHostSocketPath, ensurePrivateRuntimeDirectory, validatePrivateRuntimeDirectory } from './browserHostPaths'

describe('browser host runtime paths', () => {
  it('uses a UID-specific fallback instead of a shared tmp directory', () => {
    expect(browserHostSocketPath({}, 'linux', 1234, '/tmp')).toBe('/tmp/amber-ide-1234/browser-host.sock')
    expect(browserHostSocketPath({ XDG_RUNTIME_DIR: '/run/user/1234' }, 'linux', 1234, '/tmp')).toBe('/run/user/1234/amber-ide/browser-host.sock')
  })

  it('creates and validates an exact owner-private runtime directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-host-path-'))
    const dir = join(root, 'runtime')
    await ensurePrivateRuntimeDirectory(dir, process.getuid!())
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    await expect(validatePrivateRuntimeDirectory(dir, process.getuid!())).resolves.toBeUndefined()
    await chmod(dir, 0o770)
    await expect(validatePrivateRuntimeDirectory(dir, process.getuid!())).rejects.toThrow('0700')
  })

  it('rejects a symlink runtime directory', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'amber-host-path-'))
    const target = join(root, 'target'); await mkdir(target, { mode: 0o700 })
    const link = join(root, 'link'); await symlink(target, link)
    await expect(validatePrivateRuntimeDirectory(link, process.getuid!())).rejects.toThrow('symlink')
  })
})
