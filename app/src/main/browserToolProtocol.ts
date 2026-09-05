import { parseBrowserViewport } from '../shared/browserViewport'

export interface BrowserPageLease { pageIncarnation: string; expectedGeneration: number }
export interface BrowserElementRef { snapshotId: string; ref: string }
export interface BrowserRoleLocator { snapshotId: string; role: string; name?: string }
export type BrowserTarget = BrowserElementRef | BrowserRoleLocator
export type BrowserInteraction =
  | { kind: 'click' | 'doubleClick' | 'hover' | 'check' | 'uncheck'; target: BrowserTarget }
  | { kind: 'fill' | 'type'; target: BrowserTarget; text: string }
  | { kind: 'press'; target?: BrowserTarget; key: string }
  | { kind: 'select'; target: BrowserTarget; values: string[] }
  | { kind: 'scroll'; target?: BrowserTarget; deltaX: number; deltaY: number }
  | { kind: 'drag'; source: BrowserTarget; target: BrowserTarget }
export interface SnapshotLimits { maxDepth: number; maxNodes: number; maxBytes: number }
export interface FindQuery { text?: string; regex?: string; role?: string; name?: string; limit: number }
export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error'
export type WaitCondition =
  | { kind: 'url'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'role'; value: string; name?: string }
  | { kind: 'networkIdle' }
export interface BrowserViewport { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }

export type BrowserToolAction =
  | ({ type: 'reload'; ignoreCache: boolean } & BrowserPageLease)
  | ({ type: 'history'; direction: 'back' | 'forward' } & BrowserPageLease)
  | ({ type: 'wait'; condition: WaitCondition; timeoutMs: number } & BrowserPageLease)
  | ({ type: 'snapshot'; limits: SnapshotLimits } & BrowserPageLease)
  | ({ type: 'find'; snapshotId: string; query: FindQuery } & BrowserPageLease)
  | ({ type: 'screenshot'; target?: BrowserElementRef; fullPage: boolean } & BrowserPageLease)
  | ({ type: 'inspect'; target: BrowserElementRef } & BrowserPageLease)
  | ({ type: 'console'; cursor?: string; levels?: ConsoleLevel[]; limit: number } & BrowserPageLease)
  | ({ type: 'network'; cursor?: string; limit: number; failedOnly: boolean } & BrowserPageLease)
  | ({ type: 'setViewport'; viewport: BrowserViewport } & BrowserPageLease)
  | ({ type: 'interact'; operation: BrowserInteraction } & BrowserPageLease)

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value)
}
function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
}
function boundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function validCursor(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))
}
function pageLease(value: Record<string, unknown>): BrowserPageLease {
  if (!boundedString(value['pageIncarnation'], 256) || !boundedInt(value['expectedGeneration'], 0, Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_REQUEST')
  return { pageIncarnation: value['pageIncarnation'], expectedGeneration: value['expectedGeneration'] }
}
function elementRef(value: unknown): BrowserElementRef {
  const target = record(value)
  if (!target || !exact(target, ['snapshotId', 'ref']) || !boundedString(target['snapshotId'], 128) || !boundedString(target['ref'], 64)) throw new Error('INVALID_REQUEST')
  return { snapshotId: target['snapshotId'], ref: target['ref'] }
}
function browserTarget(value: unknown): BrowserTarget {
  const target = record(value)
  if (!target) throw new Error('INVALID_REQUEST')
  if ('ref' in target) return elementRef(target)
  if (!exact(target, ['snapshotId', 'role', 'name'], ['snapshotId', 'role']) || !boundedString(target['snapshotId'], 128) || !boundedString(target['role'], 128)
      || (target['name'] !== undefined && !boundedString(target['name'], 1024))) throw new Error('INVALID_REQUEST')
  return { snapshotId: target['snapshotId'], role: target['role'], ...(target['name'] === undefined ? {} : { name: target['name'] }) }
}
function interaction(value: unknown): BrowserInteraction {
  const operation = record(value)
  if (!operation || !boundedString(operation['kind'], 32)) throw new Error('INVALID_REQUEST')
  if (['click', 'doubleClick', 'hover', 'check', 'uncheck'].includes(operation['kind']) && exact(operation, ['kind', 'target'])) return { kind: operation['kind'] as 'click', target: browserTarget(operation['target']) }
  if ((operation['kind'] === 'fill' || operation['kind'] === 'type') && exact(operation, ['kind', 'target', 'text']) && boundedString(operation['text'], 8192, true)) return { kind: operation['kind'], target: browserTarget(operation['target']), text: operation['text'] }
  if (operation['kind'] === 'press' && exact(operation, ['kind', 'target', 'key'], ['kind', 'key']) && boundedString(operation['key'], 64) && /^(?:Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|Page(?:Up|Down)|[A-Za-z0-9])$/.test(operation['key'])) return { kind: 'press', ...(operation['target'] === undefined ? {} : { target: browserTarget(operation['target']) }), key: operation['key'] }
  if (operation['kind'] === 'select' && exact(operation, ['kind', 'target', 'values']) && Array.isArray(operation['values']) && operation['values'].length === 1 && operation['values'].every((item) => boundedString(item, 256))) return { kind: 'select', target: browserTarget(operation['target']), values: operation['values'] as string[] }
  if (operation['kind'] === 'scroll' && exact(operation, ['kind', 'target', 'deltaX', 'deltaY'], ['kind', 'deltaX', 'deltaY']) && boundedInt(operation['deltaX'], -10_000, 10_000) && boundedInt(operation['deltaY'], -10_000, 10_000)) return { kind: 'scroll', ...(operation['target'] === undefined ? {} : { target: browserTarget(operation['target']) }), deltaX: operation['deltaX'], deltaY: operation['deltaY'] }
  if (operation['kind'] === 'drag' && exact(operation, ['kind', 'source', 'target'])) return { kind: 'drag', source: browserTarget(operation['source']), target: browserTarget(operation['target']) }
  throw new Error('INVALID_REQUEST')
}
function waitCondition(value: unknown): WaitCondition {
  const condition = record(value)
  if (!condition || !boundedString(condition['kind'], 32)) throw new Error('INVALID_REQUEST')
  if (condition['kind'] === 'networkIdle' && exact(condition, ['kind'])) return { kind: 'networkIdle' }
  if ((condition['kind'] === 'url' || condition['kind'] === 'text') && exact(condition, ['kind', 'value']) && boundedString(condition['value'], condition['kind'] === 'url' ? 8192 : 4096)) return { kind: condition['kind'], value: condition['value'] }
  if (condition['kind'] === 'role' && exact(condition, ['kind', 'value', 'name'], ['kind', 'value']) && boundedString(condition['value'], 256) && (condition['name'] === undefined || boundedString(condition['name'], 4096))) return { kind: 'role', value: condition['value'], ...(condition['name'] === undefined ? {} : { name: condition['name'] }) }
  throw new Error('INVALID_REQUEST')
}
const BASE = ['type', 'pageIncarnation', 'expectedGeneration'] as const

export function parseBrowserToolAction(value: unknown): BrowserToolAction {
  const action = record(value)
  if (!action || !boundedString(action['type'], 32)) throw new Error('INVALID_REQUEST')
  const lease = pageLease(action)
  if (action['type'] === 'reload' && exact(action, [...BASE, 'ignoreCache'], BASE)) {
    if (action['ignoreCache'] !== undefined && typeof action['ignoreCache'] !== 'boolean') throw new Error('INVALID_REQUEST')
    return { type: 'reload', ...lease, ignoreCache: action['ignoreCache'] === true }
  }
  if (action['type'] === 'history' && exact(action, [...BASE, 'direction']) && (action['direction'] === 'back' || action['direction'] === 'forward')) return { type: 'history', ...lease, direction: action['direction'] }
  if (action['type'] === 'wait' && exact(action, [...BASE, 'condition', 'timeoutMs'], [...BASE, 'condition'])) {
    if (action['timeoutMs'] !== undefined && !boundedInt(action['timeoutMs'], 100, 120_000)) throw new Error('INVALID_REQUEST')
    return { type: 'wait', ...lease, condition: waitCondition(action['condition']), timeoutMs: action['timeoutMs'] as number | undefined ?? 30_000 }
  }
  if (action['type'] === 'snapshot' && exact(action, [...BASE, 'limits'], BASE)) {
    const limits = record(action['limits'] ?? {})
    if (!limits || !exact(limits, ['maxDepth', 'maxNodes', 'maxBytes'], [])) throw new Error('INVALID_REQUEST')
    const maxDepth = limits['maxDepth'] ?? 20, maxNodes = limits['maxNodes'] ?? 2_000, maxBytes = limits['maxBytes'] ?? 256 * 1024
    if (!boundedInt(maxDepth, 1, 20) || !boundedInt(maxNodes, 1, 2_000) || !boundedInt(maxBytes, 1024, 256 * 1024)) throw new Error('INVALID_REQUEST')
    return { type: 'snapshot', ...lease, limits: { maxDepth, maxNodes, maxBytes } }
  }
  if (action['type'] === 'find' && exact(action, [...BASE, 'snapshotId', 'query']) && boundedString(action['snapshotId'], 128)) {
    const query = record(action['query'])
    if (!query || !exact(query, ['text', 'regex', 'role', 'name', 'limit'], [])) throw new Error('INVALID_REQUEST')
    for (const key of ['text', 'name'] as const) if (query[key] !== undefined && !boundedString(query[key], 4096)) throw new Error('INVALID_REQUEST')
    if (query['regex'] !== undefined && !boundedString(query['regex'], 256)) throw new Error('INVALID_REQUEST')
    if (query['role'] !== undefined && !boundedString(query['role'], 256)) throw new Error('INVALID_REQUEST')
    if (query['regex'] !== undefined) {
      const source = query['regex'] as string
      // Keep regex evaluation on Electron main linear and bounded: no groups,
      // backreferences, lookarounds, counted repeats, or stacked quantifiers.
      const quantifiers = [...source].filter((char, index) => '*+?'.includes(char) && source[index - 1] !== '\\').length
      if (/[(){}]/.test(source) || /\\[1-9]/.test(source) || quantifiers > 1) throw new Error('INVALID_REQUEST')
      try { new RegExp(source, 'u') } catch { throw new Error('INVALID_REQUEST') }
    }
    const limit = query['limit'] ?? 50
    if (!boundedInt(limit, 1, 200)) throw new Error('INVALID_REQUEST')
    if (!query['text'] && !query['regex'] && !query['role'] && !query['name']) throw new Error('INVALID_REQUEST')
    return { type: 'find', ...lease, snapshotId: action['snapshotId'], query: { ...(query as Omit<FindQuery, 'limit'>), limit } }
  }
  if (action['type'] === 'inspect' && exact(action, [...BASE, 'target'])) return { type: 'inspect', ...lease, target: elementRef(action['target']) }
  if (action['type'] === 'screenshot' && exact(action, [...BASE, 'target', 'fullPage'], BASE)) {
    if (action['fullPage'] !== undefined && typeof action['fullPage'] !== 'boolean') throw new Error('INVALID_REQUEST')
    if (action['target'] !== undefined && action['fullPage'] === true) throw new Error('INVALID_REQUEST')
    return { type: 'screenshot', ...lease, ...(action['target'] === undefined ? {} : { target: elementRef(action['target']) }), fullPage: action['fullPage'] === true }
  }
  if (action['type'] === 'console' && exact(action, [...BASE, 'cursor', 'levels', 'limit'], BASE)) {
    if (action['cursor'] !== undefined && !validCursor(action['cursor'])) throw new Error('INVALID_REQUEST')
    const valid = new Set<ConsoleLevel>(['log', 'info', 'warning', 'error'])
    if (action['levels'] !== undefined && (!Array.isArray(action['levels']) || action['levels'].length > 4 || action['levels'].some((level) => !valid.has(level as ConsoleLevel)))) throw new Error('INVALID_REQUEST')
    const limit = action['limit'] ?? 100; if (!boundedInt(limit, 1, 200)) throw new Error('INVALID_REQUEST')
    return { type: 'console', ...lease, ...(action['cursor'] === undefined ? {} : { cursor: String(action['cursor']) }), ...(action['levels'] === undefined ? {} : { levels: action['levels'] as ConsoleLevel[] }), limit }
  }
  if (action['type'] === 'network' && exact(action, [...BASE, 'cursor', 'limit', 'failedOnly'], BASE)) {
    if (action['cursor'] !== undefined && !validCursor(action['cursor'])) throw new Error('INVALID_REQUEST')
    if (action['failedOnly'] !== undefined && typeof action['failedOnly'] !== 'boolean') throw new Error('INVALID_REQUEST')
    const limit = action['limit'] ?? 100; if (!boundedInt(limit, 1, 200)) throw new Error('INVALID_REQUEST')
    return { type: 'network', ...lease, ...(action['cursor'] === undefined ? {} : { cursor: String(action['cursor']) }), limit, failedOnly: action['failedOnly'] === true }
  }
  if (action['type'] === 'interact' && exact(action, [...BASE, 'operation'])) return { type: 'interact', ...lease, operation: interaction(action['operation']) }
  if (action['type'] === 'setViewport' && exact(action, [...BASE, 'viewport'])) {
    const viewport = record(action['viewport'])
    const size = viewport ? parseBrowserViewport({ width: viewport['width'], height: viewport['height'] }) : null
    if (!viewport || !size || !exact(viewport, ['width', 'height', 'deviceScaleFactor', 'mobile'], ['width', 'height'])
      || (viewport['deviceScaleFactor'] !== undefined && (typeof viewport['deviceScaleFactor'] !== 'number' || !Number.isFinite(viewport['deviceScaleFactor']) || viewport['deviceScaleFactor'] < 0.5 || viewport['deviceScaleFactor'] > 4))
      || (viewport['mobile'] !== undefined && typeof viewport['mobile'] !== 'boolean')) throw new Error('INVALID_REQUEST')
    return { type: 'setViewport', ...lease, viewport: { width: size.width, height: size.height, ...(viewport['deviceScaleFactor'] === undefined ? {} : { deviceScaleFactor: viewport['deviceScaleFactor'] }), ...(viewport['mobile'] === undefined ? {} : { mobile: viewport['mobile'] }) } }
  }
  throw new Error('INVALID_REQUEST')
}

export function isBrowserToolMutation(action: BrowserToolAction): boolean {
  return action.type === 'reload' || action.type === 'history' || action.type === 'setViewport' || action.type === 'interact'
}
