import type { SessionBookmark } from './productivity'

export const HANDOFF_VERSION = 1
export interface SessionHandoff {
  version: 1
  exportedAt: number
  session: {
    kind: string
    cwd: string
    slot?: number
    title?: string
    runState?: string
    conversationId?: string
  }
  scrollback: string
  bookmarks: SessionBookmark[]
}

export function serializeHandoff(value: SessionHandoff): string {
  // Round-trip through the parser so the file boundary always gets the same
  // bounds as an imported/inspected handoff.
  return JSON.stringify(parseHandoff(JSON.stringify(value)), null, 2)
}

export function parseHandoff(text: string): SessionHandoff {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('invalid handoff JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid handoff')
  const raw = value as Record<string, unknown>
  if (raw['version'] !== HANDOFF_VERSION) throw new Error('unsupported handoff version')
  const session = raw['session']
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('invalid handoff session')
  const s = session as Record<string, unknown>
  if (typeof s['kind'] !== 'string' || typeof s['cwd'] !== 'string') throw new Error('invalid handoff metadata')
  if (typeof raw['exportedAt'] !== 'number' || !Number.isFinite(raw['exportedAt'])) throw new Error('invalid export time')
  if (typeof raw['scrollback'] !== 'string' || raw['scrollback'].length > 4 * 1024 * 1024) throw new Error('invalid handoff scrollback')
  const optionalString = (key: string): string | undefined => {
    const result = s[key]
    if (result === undefined) return undefined
    if (typeof result !== 'string' || [...result].length > 500) throw new Error(`invalid ${key}`)
    return result
  }
  const slot = s['slot']
  if (slot !== undefined && (typeof slot !== 'number' || !Number.isFinite(slot))) throw new Error('invalid slot')
  const bookmarks = Array.isArray(raw['bookmarks']) ? raw['bookmarks'].filter((entry): entry is SessionBookmark => {
    if (!entry || typeof entry !== 'object') return false
    const b = entry as Partial<SessionBookmark>
    return typeof b.id === 'string' && typeof b.createdAt === 'number' && typeof b.label === 'string' && typeof b.excerpt === 'string'
  }).slice(0, 100).map((b) => ({ ...b, label: [...b.label].slice(0, 120).join(''), excerpt: [...b.excerpt].slice(0, 500).join('') })) : []
  return {
    version: HANDOFF_VERSION,
    exportedAt: raw['exportedAt'],
    session: {
      kind: s['kind'], cwd: s['cwd'],
      ...(slot === undefined ? {} : { slot }),
      ...(() => { const title = optionalString('title'); return title === undefined ? {} : { title } })(),
      ...(() => { const runState = optionalString('runState'); return runState === undefined ? {} : { runState } })(),
      ...(() => { const conversationId = optionalString('conversationId'); return conversationId === undefined ? {} : { conversationId } })(),
    },
    scrollback: raw['scrollback'], bookmarks,
  }
}
