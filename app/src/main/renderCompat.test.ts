import { describe, it, expect } from 'vitest'
import { compatSignature, shouldUseCompat, COMPAT_SWITCHES } from './renderCompat'

const SIG = compatSignature('43.1.0', '7.0.0-28-generic')

describe('shouldUseCompat', () => {
  it('is off when no marker and no override', () => {
    expect(shouldUseCompat({}, null, SIG)).toBe(false)
  })

  it('honours a marker written in THIS environment', () => {
    expect(shouldUseCompat({}, SIG, SIG)).toBe(true)
  })

  it('tolerates trailing whitespace in the marker', () => {
    expect(shouldUseCompat({}, SIG + '\n', SIG)).toBe(true)
  })

  it('ignores a marker from a different kernel — the bug may be fixed', () => {
    const old = compatSignature('43.1.0', '6.17.0-5-generic')
    expect(shouldUseCompat({}, old, SIG)).toBe(false)
  })

  it('ignores a marker from a different Electron build', () => {
    expect(shouldUseCompat({}, compatSignature('42.0.0', '7.0.0-28-generic'), SIG)).toBe(false)
  })

  it("ignores the legacy bare '1' marker, which names no environment", () => {
    // This is the exact file that kept a live machine on software GL across a
    // kernel upgrade. It must not win.
    expect(shouldUseCompat({}, '1', SIG)).toBe(false)
  })

  it('lets either env override force compat on', () => {
    expect(shouldUseCompat({ AMBER_SOFTWARE_GL: '1' }, null, SIG)).toBe(true)
    expect(shouldUseCompat({ AMBER_NO_SANDBOX: '1' }, null, SIG)).toBe(true)
  })

  it('env override beats a stale marker', () => {
    expect(shouldUseCompat({ AMBER_SOFTWARE_GL: '1' }, '1', SIG)).toBe(true)
  })
})

describe('COMPAT_SWITCHES', () => {
  const names = COMPAT_SWITCHES.map(([n]) => n)

  it('uses SwiftShader and the shm/sandbox workarounds', () => {
    expect(names).toContain('use-angle')
    expect(names).toContain('no-zygote')
    expect(names).toContain('disable-dev-shm-usage')
  })

  it('does NOT uncap the frame rate — that burns cores on a software rasterizer', () => {
    expect(names).not.toContain('disable-gpu-vsync')
    expect(names).not.toContain('disable-frame-rate-limit')
  })
})
