import { parseWorkspaceFile, type WorkspaceDoc } from './workspaceFile'

export const PRODUCTIVITY_VERSION = 1
export const TEMPLATE_MAX = 50
export const BOOKMARKS_PER_SESSION_MAX = 100
export const BOOKMARKS_TOTAL_MAX = 2_000

export interface WorkspaceTemplate {
  id: string
  name: string
  createdAt: number
  doc: WorkspaceDoc
}

export interface SessionBookmark {
  id: string
  createdAt: number
  label: string
  excerpt: string
}

export interface NotificationPreferences {
  activity: boolean
  exit: boolean
  retry: boolean
  fallback: boolean
  pressure: boolean
  mutedWorkspaces: number[]
}

export interface ProductivityFile {
  version: 1
  templates: WorkspaceTemplate[]
  bookmarks: Record<string, SessionBookmark[]>
  notifications: NotificationPreferences
}

export interface LoadProductivityResult { text: string | null; version: string | null }
export type SaveProductivityResult =
  | { ok: true; version: string }
  | { conflict: true; text: string | null; version: string | null }
  | { error: string }

const ID = /^[a-z0-9-]{8,64}$/
const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  activity: false,
  exit: true,
  retry: false,
  fallback: true,
  pressure: true,
  mutedWorkspaces: [],
}

export function emptyProductivity(): ProductivityFile {
  return { version: PRODUCTIVITY_VERSION, templates: [], bookmarks: {}, notifications: { ...DEFAULT_NOTIFICATIONS } }
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' ? [...value].slice(0, max).join('') : null
}

function parseTemplate(value: unknown): WorkspaceTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw['id'] !== 'string' || !ID.test(raw['id'])) return null
  const name = bounded(raw['name'], 80)
  if (name === null || typeof raw['createdAt'] !== 'number' || !Number.isFinite(raw['createdAt'])) return null
  try {
    const doc = parseWorkspaceFile(JSON.stringify(raw['doc']))
    return { id: raw['id'], name, createdAt: raw['createdAt'], doc }
  } catch { return null }
}

function parseBookmark(value: unknown): SessionBookmark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw['id'] !== 'string' || !ID.test(raw['id'])) return null
  const label = bounded(raw['label'], 120)
  const excerpt = bounded(raw['excerpt'], 500)
  if (label === null || excerpt === null || typeof raw['createdAt'] !== 'number' || !Number.isFinite(raw['createdAt'])) return null
  return { id: raw['id'], createdAt: raw['createdAt'], label, excerpt }
}

function parseNotifications(value: unknown): NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_NOTIFICATIONS }
  const raw = value as Record<string, unknown>
  const bool = (key: keyof Omit<NotificationPreferences, 'mutedWorkspaces'>): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_NOTIFICATIONS[key]
  return {
    activity: bool('activity'), exit: bool('exit'), retry: bool('retry'),
    fallback: bool('fallback'), pressure: bool('pressure'),
    mutedWorkspaces: Array.isArray(raw['mutedWorkspaces'])
      ? [...new Set(raw['mutedWorkspaces'].filter((n): n is number =>
        typeof n === 'number' && Number.isInteger(n) && n > 0))].slice(0, 100)
      : [],
  }
}

export function parseProductivity(text: string): ProductivityFile {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (!value || typeof value !== 'object' || value['version'] !== PRODUCTIVITY_VERSION) return emptyProductivity()
    const templates = Array.isArray(value['templates'])
      ? value['templates'].map(parseTemplate).filter((v): v is WorkspaceTemplate => v !== null).slice(0, TEMPLATE_MAX)
      : []
    const bookmarks: Record<string, SessionBookmark[]> = {}
    let remaining = BOOKMARKS_TOTAL_MAX
    const source = value['bookmarks']
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [session, entries] of Object.entries(source)) {
        if (remaining === 0 || !Array.isArray(entries) || session.length === 0 || session.length > 200) continue
        const parsed = entries.map(parseBookmark).filter((v): v is SessionBookmark => v !== null)
          .slice(0, Math.min(BOOKMARKS_PER_SESSION_MAX, remaining))
        if (parsed.length > 0) bookmarks[session] = parsed
        remaining -= parsed.length
      }
    }
    return { version: PRODUCTIVITY_VERSION, templates, bookmarks, notifications: parseNotifications(value['notifications']) }
  } catch { return emptyProductivity() }
}

export function serializeProductivity(file: ProductivityFile): string {
  return JSON.stringify(parseProductivity(JSON.stringify(file)))
}

export function mutateProductivity(
  current: ProductivityFile,
  mutation: (fresh: ProductivityFile) => ProductivityFile,
): ProductivityFile {
  return parseProductivity(JSON.stringify(mutation(parseProductivity(JSON.stringify(current)))))
}

export function replayProductivity(
  base: ProductivityFile,
  mutations: Array<(fresh: ProductivityFile) => ProductivityFile>,
): ProductivityFile {
  return mutations.reduce((file, mutation) => mutateProductivity(file, mutation), base)
}
