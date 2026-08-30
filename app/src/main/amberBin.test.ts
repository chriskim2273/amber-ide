import { describe, it, expect } from 'vitest'
import { resolveAmberBinary, resolveAmberDaemonBinary, windowsAmberPath, windowsDaemonPath } from './amberBin'

describe('resolveAmberBinary', () => {
  it('honors AMBER_BIN override', () => {
    expect(resolveAmberBinary({ AMBER_BIN: '/x/amber' }, true, '/res', 'linux')).toBe('/x/amber')
  })
  it('uses the bundled resources path when packaged', () => {
    expect(resolveAmberBinary({}, true, '/app/resources', 'linux')).toBe('/app/resources/bin/amber')
  })
  it('falls back to PATH lookup in dev', () => {
    expect(resolveAmberBinary({}, false, '/app/resources', 'linux')).toBe('amber')
  })

  it('uses .exe resources on packaged Windows', () => {
    expect(resolveAmberBinary({}, true, 'C:\\app\\resources', 'win32'))
      .toBe('C:\\app\\resources\\bin\\amber.exe')
    expect(resolveAmberDaemonBinary({}, true, 'C:\\app\\resources', 'win32'))
      .toBe('C:\\app\\resources\\bin\\amberd.exe')
  })

  it('derives stable per-user Windows executable paths', () => {
    expect(windowsAmberPath('C:\\Users\\alice\\AppData\\Local'))
      .toBe('C:\\Users\\alice\\AppData\\Local\\Programs\\amber-ide\\amber.exe')
    expect(windowsDaemonPath('C:\\Users\\alice\\AppData\\Local'))
      .toBe('C:\\Users\\alice\\AppData\\Local\\Programs\\amber-ide\\amberd.exe')
  })
})
