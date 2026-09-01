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

interface LiveEntry { lastUsedAt: number; protected: boolean }

/** Pure four-live renderer policy. OS process count is deliberately unrelated. */
export class BrowserCapacity {
  private readonly live = new Map<string, LiveEntry>()
  constructor(private readonly maxLive = 4) {}
  markLive(id: string, lastUsedAt: number): void { this.live.set(id, { lastUsedAt, protected: this.live.get(id)?.protected ?? false }) }
  markFrozen(id: string): void { this.live.delete(id) }
  protect(id: string, protectedValue: boolean): void {
    const value = this.live.get(id)
    if (value) value.protected = protectedValue
  }
  touch(id: string, lastUsedAt: number): void { const value = this.live.get(id); if (value) value.lastUsedAt = lastUsedAt }
  liveIds(): string[] { return [...this.live.keys()] }
  activate(id: string, now: number): { freeze?: string; busy?: true } {
    if (this.live.has(id)) { this.touch(id, now); return {} }
    if (this.live.size < this.maxLive) { this.markLive(id, now); return {} }
    const eligible = [...this.live.entries()].filter(([, value]) => !value.protected).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt || a[0].localeCompare(b[0]))
    const victim = eligible[0]?.[0]
    if (!victim) return { busy: true }
    this.live.delete(victim)
    this.markLive(id, now)
    return { freeze: victim }
  }
}
