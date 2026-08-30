import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(
  fileURLToPath(new URL('../package.json', import.meta.url)),
  'utf8',
)) as {
  name: string
  build: {
    productName: string
    win: { target: Array<{ target: string; arch: string[] }> }
    nsis: Record<string, unknown>
  }
}

describe('Windows NSIS packaging', () => {
  it('uses the stable per-user install directory expected by daemon setup', () => {
    expect(manifest.name).toBe('amber-ide')
    expect(manifest.build.productName).toBe('amber-ide')
  })

  it('enforces a non-elevated per-user installer with no install-mode choice', () => {
    expect(manifest.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(manifest.build.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      allowElevation: false,
    })
  })
})
