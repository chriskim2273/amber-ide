import { isDaemonSessionKind, type DaemonSessionKind } from './proto'

export interface ProjectPane {
  kind: DaemonSessionKind
  cwd: string
  direction: 'h' | 'v'
}
export interface ProjectProfile { version: 1; name: string; panes: ProjectPane[] }

function fail(line: number, message: string): never {
  throw new Error(`invalid .amber.toml at line ${line}: ${message}`)
}

function parseString(raw: string, line: number): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) fail(line, 'value must be a double-quoted string')
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'string' || value.includes('\0')) fail(line, 'invalid string')
    return value
  } catch { return fail(line, 'malformed quoted string') }
}

function profileCwd(value: string, line: number): string {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(line, 'cwd must be a relative path')
  }
  const parts = value.replaceAll('\\', '/').split('/')
  if (parts.some((part) => part === '..')) fail(line, 'cwd may not contain ..')
  return parts.filter((part) => part !== '' && part !== '.').join('/') || '.'
}

/** Strict parser for Amber's deliberately tiny, non-executable TOML subset. */
export function parseProjectProfile(text: string): ProjectProfile {
  let version: number | null = null
  let name = ''
  const panes: Array<Partial<ProjectPane> & { lines: Record<string, number> }> = []
  let current: (typeof panes)[number] | null = null
  const seenTop = new Set<string>()

  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = index + 1
    const trimmed = original.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '[[pane]]') {
      current = { lines: {} }
      panes.push(current)
      if (panes.length > 32) fail(line, 'at most 32 panes are allowed')
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed)
    if (!match) fail(line, 'expected key = value or [[pane]]')
    const key = match[1]!
    const raw = match[2]!.trim()
    if (current === null) {
      if (key !== 'version' && key !== 'name') fail(line, `unsupported top-level key ${key}`)
      if (seenTop.has(key)) fail(line, `duplicate key ${key}`)
      seenTop.add(key)
      if (key === 'version') {
        if (!/^\d+$/.test(raw)) fail(line, 'version must be an integer')
        version = Number(raw)
      } else name = parseString(raw, line).slice(0, 80)
      continue
    }
    if (key !== 'kind' && key !== 'cwd' && key !== 'direction') fail(line, `unsupported pane key ${key}`)
    if (current.lines[key] !== undefined) fail(line, `duplicate pane key ${key}`)
    current.lines[key] = line
    const value = parseString(raw, line)
    if (key === 'kind') {
      if (!isDaemonSessionKind(value)) fail(line, `unsupported pane kind ${value}`)
      current.kind = value
    } else if (key === 'cwd') current.cwd = profileCwd(value, line)
    else {
      if (value !== 'h' && value !== 'v') fail(line, 'direction must be h or v')
      current.direction = value
    }
  }

  if (version !== 1) throw new Error('invalid .amber.toml: version must be 1')
  if (panes.length === 0) throw new Error('invalid .amber.toml: at least one [[pane]] is required')
  const complete = panes.map((pane, index): ProjectPane => {
    if (!pane.kind) throw new Error(`invalid .amber.toml: pane ${index + 1} is missing kind`)
    if (!pane.cwd) throw new Error(`invalid .amber.toml: pane ${index + 1} is missing cwd`)
    return { kind: pane.kind, cwd: pane.cwd, direction: pane.direction ?? 'h' }
  })
  return { version: 1, name, panes: complete }
}
