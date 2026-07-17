// Correlate per-session DumpBacklog requests with their Backlog replies. The
// daemon replies asynchronously over the shared control channel (no request id
// on the wire — the session NAME is the correlation key), so this fans out N
// requests, collects the replies by name, and resolves after all land OR a
// per-save timeout, reporting stragglers (panes whose dump never arrived) so the
// caller can save with empty scrollback for them and surface a banner.

export interface DumpResult {
  dumps: Record<string, Uint8Array>
  stragglers: string[]
}

export function collectDumps(
  names: string[],
  request: (name: string) => void,
  register: (name: string, resolve: (data: Uint8Array) => void) => void,
  unregister: (name: string) => void,
  timeoutMs = 5000,
): Promise<DumpResult> {
  return new Promise((resolve) => {
    const dumps: Record<string, Uint8Array> = {}
    const remaining = new Set(names)
    if (remaining.size === 0) { resolve({ dumps, stragglers: [] }); return }
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      // Drop any still-pending resolvers so a late reply can't call a stale cb.
      for (const n of remaining) unregister(n)
      resolve({ dumps, stragglers: [...remaining] })
    }
    for (const name of names) {
      register(name, (data) => {
        // Ignore a duplicate/late reply (already timed out and unregistered).
        if (!remaining.has(name)) return
        dumps[name] = data
        remaining.delete(name)
        if (remaining.size === 0) finish()
      })
      request(name)
    }
    timer = setTimeout(finish, timeoutMs)
  })
}
