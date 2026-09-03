import type { WebPreferences } from 'electron'

export function browserWebPreferences(partition: string): WebPreferences {
  if (!/^persist:amber-browser(?:-[a-z0-9-]+)?$/.test(partition)) throw new Error('invalid Amber browser partition')
  return {
    partition,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  }
}

export function isAllowedBrowserUrl(value: string): boolean {
  if (value === 'about:blank') return true
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch { return false }
}

export const MAX_PREVIEW_ORIGINS = 32

export function navigationOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('NAVIGATION_BLOCKED') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin.length > 256) throw new Error('NAVIGATION_BLOCKED')
  return url.origin
}

function loopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  const parts = normalized.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Main-owned policy shared by direct loads, redirects, SPA projection, and broker navigation. */
export function navigationPolicyAllows(mode: 'preview' | 'browse', previewOrigins: readonly string[], value: string): boolean {
  if (value === 'about:blank') return true
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (mode === 'browse') return true
  return loopback(url.hostname) || previewOrigins.includes(url.origin)
}

/** Record an explicit trusted-renderer development-origin selection, never a broker choice. */
export function selectPreviewOrigin(current: readonly string[], value: string): string[] {
  const origin = navigationOrigin(value)
  if (current.includes(origin)) return [...current]
  if (current.length >= MAX_PREVIEW_ORIGINS) throw new Error('PREVIEW_ORIGIN_LIMIT')
  return [...current, origin]
}

interface LiveEntry { lastUsedAt: number; protections: Set<string> }
interface CapacityAdmission { inserted: boolean; victim?: { id: string; entry: LiveEntry }; victimFrozen: boolean }
interface CapacityWaiter {
  id: string; now: number; promise: Promise<{ freeze?: string }>
  resolve: (value: { freeze?: string }) => void; reject: (error: Error) => void
  timer: NodeJS.Timeout; signal?: AbortSignal; abort?: () => void; onWaiting?: (waiting: boolean) => void
}

/** Pure four-live renderer policy. OS process count is deliberately unrelated. */
export class BrowserCapacity {
  private readonly live = new Map<string, LiveEntry>()
  private readonly queue: CapacityWaiter[] = []
  private readonly pending = new Map<string, CapacityWaiter>()
  private readonly admissions = new Map<string, CapacityAdmission>()
  constructor(private readonly maxLive = 4, private readonly waitMs = 10_000, private readonly maxQueue = 8) {}
  markLive(id: string, lastUsedAt: number): void { this.live.set(id, { lastUsedAt, protections: this.live.get(id)?.protections ?? new Set() }) }
  markFrozen(id: string): void {
    this.live.delete(id)
    // Admission is allowed to defer validation while the selected victim is
    // being frozen. If the victim closes or crashes in that window, rollback
    // must not turn its old capacity entry into a phantom renderer.
    for (const admission of this.admissions.values()) if (admission.victim?.id === id) admission.victimFrozen = true
    this.drain()
  }
  protect(id: string, protectedValue: boolean): void { this.protectFor(id, 'visible', protectedValue) }
  protectFor(id: string, reason: 'visible' | 'operation' | 'approval' | 'activation', protectedValue: boolean): void {
    const value = this.live.get(id)
    if (!value) return
    if (protectedValue) value.protections.add(reason)
    else value.protections.delete(reason)
    if (!protectedValue) this.drain()
  }
  touch(id: string, lastUsedAt: number): void { const value = this.live.get(id); if (value) value.lastUsedAt = lastUsedAt }
  liveIds(): string[] { return [...this.live.keys()] }
  activate(id: string, now: number): { freeze?: string; busy?: true } {
    if (this.live.has(id)) { this.touch(id, now); return {} }
    if (this.live.size < this.maxLive) { this.markLive(id, now); return {} }
    const eligible = [...this.live.entries()].filter(([, value]) => value.protections.size === 0).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[0].localeCompare(b[0]))
    const victim = eligible[0]?.[0]
    if (!victim) return { busy: true }
    this.live.delete(victim)
    this.markLive(id, now)
    return { freeze: victim }
  }
  waitingIds(): string[] { return this.queue.map((entry) => entry.id) }
  cancel(id: string): void { const waiter = this.pending.get(id); if (waiter) this.remove(waiter, new Error('ACTION_CANCELLED')) }
  markAdmissionVictimFrozen(id: string): void { const admission = this.admissions.get(id); if (admission) admission.victimFrozen = true }
  rollbackActivation(id: string): void {
    const admission = this.admissions.get(id)
    if (!admission) return
    this.admissions.delete(id)
    if (admission.inserted) this.live.delete(id)
    if (admission.victim && !admission.victimFrozen && !this.live.has(admission.victim.id)) this.live.set(admission.victim.id, admission.victim.entry)
    this.drain()
  }
  settleActivation(id: string): void { this.admissions.delete(id); this.protectFor(id, 'activation', false) }
  activateQueued(id: string, now: number, signal?: AbortSignal, onWaiting?: (waiting: boolean) => void): Promise<{ freeze?: string }> {
    if (signal?.aborted) return Promise.reject(new Error('ACTION_CANCELLED'))
    const immediate = this.admit(id, now)
    if (!immediate.busy) { this.protectFor(id, 'activation', true); return Promise.resolve(immediate) }
    const existing = this.pending.get(id)
    if (existing) return existing.promise
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('BROWSER_CAPACITY_BUSY'))
    let resolve!: CapacityWaiter['resolve']; let reject!: CapacityWaiter['reject']
    const promise = new Promise<{ freeze?: string }>((res, rej) => { resolve = res; reject = rej })
    const waiter: CapacityWaiter = {
      id, now, promise, resolve, reject, ...(signal ? { signal } : {}), ...(onWaiting ? { onWaiting } : {}),
      timer: setTimeout(() => this.remove(waiter, new Error('BROWSER_CAPACITY_BUSY')), this.waitMs),
    }
    if (signal) {
      waiter.abort = () => this.remove(waiter, new Error('ACTION_CANCELLED'))
      signal.addEventListener('abort', waiter.abort, { once: true })
    }
    this.queue.push(waiter); this.pending.set(id, waiter); onWaiting?.(true)
    return promise
  }
  private admit(id: string, now: number): { freeze?: string; busy?: true } {
    if (this.live.has(id)) { this.touch(id, now); this.admissions.set(id, { inserted: false, victimFrozen: false }); return {} }
    if (this.live.size < this.maxLive) { this.markLive(id, now); this.admissions.set(id, { inserted: true, victimFrozen: false }); return {} }
    const eligible = [...this.live.entries()].filter(([, value]) => value.protections.size === 0).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[0].localeCompare(b[0]))
    const selected = eligible[0]
    if (!selected) return { busy: true }
    const [victim, entry] = selected
    this.live.delete(victim); this.markLive(id, now)
    this.admissions.set(id, { inserted: true, victim: { id: victim, entry }, victimFrozen: false })
    return { freeze: victim }
  }
  private remove(waiter: CapacityWaiter, error?: Error): void {
    if (this.pending.get(waiter.id) !== waiter) return
    this.pending.delete(waiter.id)
    const index = this.queue.indexOf(waiter)
    if (index >= 0) this.queue.splice(index, 1)
    clearTimeout(waiter.timer)
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
    waiter.onWaiting?.(false)
    if (error) waiter.reject(error)
  }
  private drain(): void {
    const waiter = this.queue[0]
    if (!waiter) return
    const activation = this.admit(waiter.id, waiter.now)
    if (activation.busy) return
    this.protectFor(waiter.id, 'activation', true)
    this.remove(waiter)
    waiter.resolve(activation)
  }
}
