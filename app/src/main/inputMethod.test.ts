import { describe, expect, it, vi } from 'vitest'
import {
  inspectLinuxInputMethod,
  parseIbusAddress,
  repairLinuxInputMethod,
  type CaptureResult,
} from './inputMethod'

const ok = (stdout: string): CaptureResult => ({ code: 0, stdout, stderr: '' })

function expectedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISPLAY: ':1',
    XMODIFIERS: '@im=ibus',
    QT_IM_MODULE: 'ibus',
    ...overrides,
  }
}

describe('parseIbusAddress', () => {
  it('extracts and decodes a unix socket path', () => {
    expect(parseIbusAddress('unix:path=/home/u/.cache/ibus/dbus-a%20b,guid=123\n'))
      .toEqual({ kind: 'path', path: '/home/u/.cache/ibus/dbus-a b' })
  })

  it('accepts abstract unix addresses without inventing a filesystem path', () => {
    expect(parseIbusAddress('unix:abstract=/tmp/dbus-abc,guid=123'))
      .toEqual({ kind: 'abstract' })
  })

  it.each(['', '(null)', 'tcp:host=localhost'])('rejects unusable address %j', (address) => {
    expect(parseIbusAddress(address)).toBeNull()
  })
})

describe('inspectLinuxInputMethod', () => {
  it('does nothing outside Linux', async () => {
    const run = vi.fn()
    expect(await inspectLinuxInputMethod({
      platform: 'darwin', env: expectedEnv(), run, isSocket: vi.fn(),
    })).toEqual({ status: 'not-applicable' })
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing when IBus is not selected', async () => {
    const run = vi.fn()
    expect(await inspectLinuxInputMethod({
      platform: 'linux', env: expectedEnv({ XMODIFIERS: '@im=none', QT_IM_MODULE: '' }),
      run, isSocket: vi.fn(),
    })).toEqual({ status: 'not-applicable' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a live filesystem socket as healthy', async () => {
    const run = vi.fn().mockResolvedValue(ok('unix:path=/run/user/1/ibus.sock,guid=a'))
    const isSocket = vi.fn().mockResolvedValue(true)
    expect(await inspectLinuxInputMethod({ platform: 'linux', env: expectedEnv(), run, isSocket }))
      .toEqual({ status: 'healthy', socketPath: '/run/user/1/ibus.sock' })
    expect(run).toHaveBeenCalledWith('ibus', ['address'])
    expect(isSocket).toHaveBeenCalledWith('/run/user/1/ibus.sock')
  })

  it('reports a missing socket as stale', async () => {
    const run = vi.fn().mockResolvedValue(ok('unix:path=/gone/ibus.sock,guid=a'))
    expect(await inspectLinuxInputMethod({
      platform: 'linux', env: expectedEnv(), run, isSocket: vi.fn().mockResolvedValue(false),
    })).toEqual({
      status: 'stale',
      reason: 'IBus points to a missing socket: /gone/ibus.sock',
    })
  })

  it('reports an unavailable address as stale', async () => {
    const run = vi.fn().mockResolvedValue(ok('(null)'))
    expect(await inspectLinuxInputMethod({
      platform: 'linux', env: expectedEnv(), run, isSocket: vi.fn(),
    })).toEqual({ status: 'stale', reason: 'IBus did not publish a usable address' })
  })

  it('accepts an abstract socket address', async () => {
    expect(await inspectLinuxInputMethod({
      platform: 'linux', env: expectedEnv(),
      run: vi.fn().mockResolvedValue(ok('unix:abstract=/tmp/dbus-a,guid=a')),
      isSocket: vi.fn(),
    })).toEqual({ status: 'healthy', socketPath: null })
  })
})

describe('repairLinuxInputMethod', () => {
  it('uses the documented GNOME systemd restart and waits for a live socket', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValueOnce(ok('unix:path=/run/user/1/new.sock,guid=a'))
    const delay = vi.fn().mockResolvedValue(undefined)

    const result = await repairLinuxInputMethod({
      platform: 'linux', env: expectedEnv(), run,
      isSocket: vi.fn().mockResolvedValue(true), delay, attempts: 3,
    })

    expect(run.mock.calls[0]).toEqual(['ibus', ['restart', '--type=systemd']])
    expect(result).toEqual({ status: 'healthy', socketPath: '/run/user/1/new.sock' })
    expect(delay).not.toHaveBeenCalled()
  })

  it('returns a precise failure when restart itself fails', async () => {
    const result = await repairLinuxInputMethod({
      platform: 'linux', env: expectedEnv(),
      run: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'unit failed\n' }),
      isSocket: vi.fn(), delay: vi.fn(), attempts: 2,
    })
    expect(result).toEqual({ status: 'stale', reason: 'Could not restart IBus: unit failed' })
  })

  it('does not report success until the replacement socket exists', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(ok(''))
      .mockResolvedValue(ok('unix:path=/run/user/1/new.sock,guid=a'))
    const isSocket = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const delay = vi.fn().mockResolvedValue(undefined)

    expect(await repairLinuxInputMethod({
      platform: 'linux', env: expectedEnv(), run, isSocket, delay, attempts: 3,
    })).toEqual({ status: 'healthy', socketPath: '/run/user/1/new.sock' })
    expect(delay).toHaveBeenCalledTimes(1)
  })
})
