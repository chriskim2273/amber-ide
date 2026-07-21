import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { installBinary } from './installBinary'

const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids) k.kill('SIGKILL')
  kids.length = 0
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'amber-install-'))
  dirs.push(d)
  return d
}

const script = (body: string): string => `#!/bin/sh\n${body}\n`

describe('installBinary', () => {
  it('replaces a binary that is CURRENTLY EXECUTING', async () => {
    // The regression: copyFile() into a running executable fails with ETXTBSY,
    // and ~/.local/bin/amber is the live daemon's image — a packaged launch
    // died at startup on exactly this.
    // Must be a REAL ELF: a #!/bin/sh script is read and closed by the kernel
    // (it execs /bin/sh), so it is never held as an executable image and never
    // produces ETXTBSY. Copying a real binary is what reproduces the bug.
    const d = tmp()
    const dest = join(d, 'amber')
    copyFileSync('/bin/sleep', dest)
    chmodSync(dest, 0o755)

    const running = spawn(dest, ['30'], { stdio: 'ignore' })
    kids.push(running)
    await new Promise((r) => setTimeout(r, 300)) // let it exec

    const src = join(d, 'new-amber')
    writeFileSync(src, script('echo v2'))

    await expect(installBinary(src, dest)).resolves.toBeUndefined()
    expect(readFileSync(dest, 'utf8')).toContain('echo v2')
    expect(running.exitCode).toBeNull() // the old process is untouched
  })

  it('leaves the destination alone and cleans up when the source is missing', async () => {
    const d = tmp()
    const dest = join(d, 'amber')
    writeFileSync(dest, script('echo original'))

    await expect(installBinary(join(d, 'nope'), dest)).rejects.toThrow()

    expect(readFileSync(dest, 'utf8')).toContain('echo original')
    // No temp turd left behind.
    expect(readdirSync(d).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('creates the destination when nothing is there yet', async () => {
    const d = tmp()
    const src = join(d, 'src')
    writeFileSync(src, script('echo fresh'))

    await installBinary(src, join(d, 'amber'))

    expect(readFileSync(join(d, 'amber'), 'utf8')).toContain('echo fresh')
  })
})
