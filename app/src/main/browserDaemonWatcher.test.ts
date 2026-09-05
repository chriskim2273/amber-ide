import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/proto'
import { BrowserDaemonWatcher, type MetadataConnection } from './browserDaemonWatcher'

class FakeConnection implements MetadataConnection {
  sent: Frame[] = []; closed = false; private currentEpoch = 0; private nextEpoch = 1
  callbacks: Record<'open'|'close'|'frame', Function[]> = { open: [], close: [], frame: [] }
  on(event: 'frame', cb: (value: Frame, epoch: number) => void): void
  on(event: 'open'|'close', cb: (epoch: number) => void): void
  on(event: 'open'|'close'|'frame', cb: ((value: Frame, epoch: number) => void) | ((epoch: number) => void)): void { this.callbacks[event].push(cb) }
  connect(): void {}
  send(frame: Frame): void { this.sent.push(frame) }
  close(): void { this.closed = true }
  emit(event: 'open'|'close', epoch?: number): void
  emit(event: 'frame', value: Frame, epoch?: number): void
  emit(event: 'open'|'close'|'frame', value?: Frame | number, epoch?: number): void {
    const frame = typeof value === 'number' ? undefined : value
    const eventEpoch = typeof value === 'number' ? value : epoch ?? (event === 'open' ? this.nextEpoch++ : this.currentEpoch)
    if (event === 'open') { this.currentEpoch = eventEpoch; this.nextEpoch = Math.max(this.nextEpoch, eventEpoch + 1) }
    for (const cb of this.callbacks[event]) event === 'frame' ? cb(frame, eventEpoch) : cb(eventEpoch)
  }
}

const sessions = (items: unknown[]): Frame => ({ type: 'control', msg: { kind: 'Sessions', sessions: items as never[] } })

describe('BrowserDaemonWatcher', () => {
  it('requires a current-epoch full list and rejects dead or shell fallback Pi', () => {
    let now = 10; const connection = new FakeConnection()
    const watcher = new BrowserDaemonWatcher(connection, () => now, 5000)
    watcher.start(); connection.emit('open')
    expect(watcher.controller('pi')).toBeUndefined()
    connection.emit('frame', sessions([{ name: 'pi', cwd: '/', kind: 'pi', alive: true, run_state: 'claude' }]))
    expect(watcher.controller('pi')).toMatchObject({ kind: 'pi', alive: true })
    now += 5001; expect(watcher.controller('pi')).toBeUndefined()
    connection.emit('frame', sessions([{ name: 'pi', cwd: '/', kind: 'pi', alive: true, run_state: 'shell-fallback' }]))
    expect(watcher.controller('pi')).toMatchObject({ runState: 'shell-fallback' })
  })

  it('drops cached authority on disconnect and ignores deltas before the next full list', () => {
    const connection = new FakeConnection(); const watcher = new BrowserDaemonWatcher(connection)
    watcher.start(); connection.emit('open')
    connection.emit('frame', sessions([{ name: 'pi', cwd: '/', kind: 'pi', alive: true }]))
    expect(watcher.controller('pi')).toBeDefined()
    connection.emit('close'); expect(watcher.controller('pi')).toBeUndefined()
    connection.emit('open')
    connection.emit('frame', { type: 'control', msg: { kind: 'SessionsChanged', added: [{ name: 'other', cwd: '/', kind: 'pi', alive: true }], removed: [] } })
    expect(watcher.controller('other')).toBeUndefined()
  })

  it('does not report startup readiness until this connection epoch receives a full list', async () => {
    vi.useFakeTimers()
    try {
      const connection = new FakeConnection(); const watcher = new BrowserDaemonWatcher(connection)
      watcher.start()
      const ready = watcher.waitForFresh(1000)
      connection.emit('open')
      let settled = false; void ready.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(500); expect(settled).toBe(false)
      connection.emit('frame', sessions([]))
      await expect(ready).resolves.toBe(true)
      watcher.close()
      await expect(watcher.waitForFresh(10)).resolves.toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('polls only metadata and closes cleanly', () => {
    vi.useFakeTimers()
    const connection = new FakeConnection(); const watcher = new BrowserDaemonWatcher(connection, Date.now, 5000, 2000)
    watcher.start(); connection.emit('open')
    expect(connection.sent.map((f) => f.type === 'control' ? f.msg.kind : '')).toEqual(['WatchSessions', 'ListSessionsDetailed'])
    vi.advanceTimersByTime(2000)
    expect(connection.sent.at(-1)).toEqual({ type: 'control', msg: { kind: 'ListSessionsDetailed' } })
    watcher.close(); expect(connection.closed).toBe(true)
    vi.useRealTimers()
  })

  it('ignores old socket events after a newer connection epoch takes over', () => {
    const connection = new FakeConnection(); const watcher = new BrowserDaemonWatcher(connection)
    watcher.start(); connection.emit('open', 1)
    connection.emit('frame', sessions([{ name: 'old', cwd: '/', kind: 'pi', alive: true }]), 1)
    expect(watcher.controller('old')).toBeDefined()
    connection.emit('open', 2)
    connection.emit('frame', sessions([{ name: 'stale', cwd: '/', kind: 'pi', alive: true }]), 1)
    connection.emit('close', 1)
    expect(watcher.controller('stale')).toBeUndefined()
    connection.emit('frame', sessions([{ name: 'new', cwd: '/', kind: 'pi', alive: true }]), 2)
    expect(watcher.controller('new')).toBeDefined()
    expect(watcher.controller('old')).toBeUndefined()
  })

  it('cannot restore readiness or authority from callbacks delivered after close', async () => {
    const connection = new FakeConnection(); const watcher = new BrowserDaemonWatcher(connection)
    watcher.start(); connection.emit('open', 7)
    const ready = watcher.waitForFresh(1000)
    watcher.close()
    connection.emit('open', 7)
    connection.emit('frame', sessions([{ name: 'late', cwd: '/', kind: 'pi', alive: true }]), 7)
    await expect(ready).resolves.toBe(false)
    expect(watcher.controller('late')).toBeUndefined()
  })
})
