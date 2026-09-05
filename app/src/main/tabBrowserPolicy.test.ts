import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCapacity, browserWebPreferences, isAllowedBrowserUrl, navigationOrigin, navigationPolicyAllows, selectPreviewOrigin } from './tabBrowserPolicy'

describe('browser security policy', () => {
  it('creates hardened remote preferences', () => {
    expect(browserWebPreferences('persist:amber-browser')).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'persist:amber-browser' })
    expect(browserWebPreferences('persist:amber-browser')).not.toHaveProperty('preload')
  })
  it('allows only HTTP(S) and exact about:blank', () => {
    expect(isAllowedBrowserUrl('https://example.test/a')).toBe(true)
    expect(isAllowedBrowserUrl('about:blank')).toBe(true)
    expect(isAllowedBrowserUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false)
  })
  it('centralizes Browse and Preview origin policy for paths and redirects', () => {
    expect(navigationPolicyAllows('browse', [], 'https://any.example/path')).toBe(true)
    expect(navigationPolicyAllows('preview', [], 'http://localhost:3000/path')).toBe(true)
    expect(navigationPolicyAllows('preview', [], 'http://127.9.8.7:4000/path')).toBe(true)
    expect(navigationPolicyAllows('preview', [], 'http://[::1]:5000/path')).toBe(true)
    expect(navigationPolicyAllows('preview', [], 'https://dev.example/path')).toBe(false)
    expect(navigationPolicyAllows('preview', ['https://dev.example'], 'https://dev.example/other?q=1')).toBe(true)
    expect(navigationPolicyAllows('preview', ['https://dev.example'], 'https://redirect.example/')).toBe(false)
    expect(navigationPolicyAllows('preview', ['https://dev.example'], 'javascript:alert(1)')).toBe(false)
  })
  it('records only bounded explicit user-selected Preview origins', () => {
    expect(navigationOrigin('https://dev.example/a')).toBe('https://dev.example')
    expect(selectPreviewOrigin([], 'https://dev.example/a')).toEqual(['https://dev.example'])
    expect(selectPreviewOrigin(['https://dev.example'], 'https://dev.example/b')).toEqual(['https://dev.example'])
    expect(() => selectPreviewOrigin([], 'file:///tmp/site')).toThrow('NAVIGATION_BLOCKED')
    expect(() => selectPreviewOrigin(Array.from({ length: 32 }, (_, index) => `https://dev-${index}.example`), 'https://overflow.example')).toThrow('PREVIEW_ORIGIN_LIMIT')
  })
})

afterEach(() => vi.useRealTimers())

describe('four-live capacity', () => {
  it('freezes the eligible least-recent browser', () => {
    const c = new BrowserCapacity(4)
    for (let i = 1; i <= 4; i++) c.markLive(`b${i}`, i)
    c.protect('b1', true)
    expect(c.activate('b5', 5)).toEqual({ freeze: 'b2' })
    expect(c.liveIds()).toEqual(['b1', 'b3', 'b4', 'b5'])
  })
  it('fails boundedly when all live pages are protected', () => {
    const c = new BrowserCapacity(2)
    c.markLive('a', 1); c.markLive('b', 2); c.protect('a', true); c.protect('b', true)
    expect(c.activate('c', 3)).toEqual({ busy: true })
  })
  it('queues activations FIFO and protects visible, operation, and approval reasons', async () => {
    const c = new BrowserCapacity(2)
    c.markLive('a', 1); c.markLive('b', 2)
    c.protect('a', true); c.protectFor('b', 'operation', true); c.protectFor('b', 'approval', true)
    const first = c.activateQueued('c', 3)
    const second = c.activateQueued('d', 4)
    expect(c.waitingIds()).toEqual(['c', 'd'])
    c.protect('a', false)
    await expect(first).resolves.toEqual({ freeze: 'a' })
    expect(c.waitingIds()).toEqual(['d'])
    c.protectFor('b', 'operation', false)
    expect(c.waitingIds()).toEqual(['d'])
    c.protectFor('b', 'approval', false)
    await expect(second).resolves.toEqual({ freeze: 'b' })
  })
  it('atomically rolls back a selected victim, but never revives one already frozen', async () => {
    const selected = new BrowserCapacity(2)
    selected.markLive('a', 1); selected.markLive('b', 2)
    await expect(selected.activateQueued('c', 3)).resolves.toEqual({ freeze: 'a' })
    expect(selected.liveIds()).toEqual(['b', 'c'])
    selected.rollbackActivation('c')
    expect(selected.liveIds()).toEqual(['b', 'a'])
    await expect(selected.activateQueued('d', 4)).resolves.toEqual({ freeze: 'a' })

    const frozen = new BrowserCapacity(1)
    frozen.markLive('a', 1)
    await expect(frozen.activateQueued('c', 2)).resolves.toEqual({ freeze: 'a' })
    frozen.markAdmissionVictimFrozen('c'); frozen.markFrozen('a')
    frozen.rollbackActivation('c')
    expect(frozen.liveIds()).toEqual([])
  })

  it('bounds the activation queue, joins one browser, cancels, and times out deterministically', async () => {
    vi.useFakeTimers()
    const c = new BrowserCapacity(1, 10_000, 2)
    c.markLive('a', 1); c.protect('a', true)
    const controller = new AbortController()
    const first = c.activateQueued('b', 2, controller.signal)
    expect(c.activateQueued('b', 3)).toBe(first)
    const second = c.activateQueued('c', 3)
    await expect(c.activateQueued('d', 4)).rejects.toThrow('BROWSER_CAPACITY_BUSY')
    controller.abort()
    await expect(first).rejects.toThrow('ACTION_CANCELLED')
    expect(c.waitingIds()).toEqual(['c'])
    const timedOut = expect(second).rejects.toThrow('BROWSER_CAPACITY_BUSY')
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOut
    expect(c.waitingIds()).toEqual([])
  })
})
