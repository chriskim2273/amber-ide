// TS port of amber-core::proto. Wire: [u32 BE body_len][u8 tag][body].
// tag 0 = Control (JSON of ControlMsg, serde externally-tagged).
// tag 1 = Data ([u16 BE name_len][name utf8][raw bytes]).

export type DaemonSessionKind = 'shell' | 'claude' | 'grok' | 'codex' | 'opencode' | 'hermes' | 'pi'

export function isDaemonSessionKind(kind: unknown): kind is DaemonSessionKind {
  return kind === 'shell' || kind === 'claude' || kind === 'grok' || kind === 'codex'
    || kind === 'opencode' || kind === 'hermes' || kind === 'pi'
}

export interface SearchResult {
  name: string
  line: number
  preview: string
}

export interface SessionInfo {
  name: string
  cwd: string
  kind: DaemonSessionKind
  alive: boolean
  // Unix seconds of the session's last state-store write; the daemon's
  // ordering key for "most recent". Optional on the wire (serde default 0);
  // the app does not use it today.
  updated?: number
  // Stable per-session number owned by the daemon (spec
  // 2026-07-19-stable-session-slots): what `amber ls` prints and what
  // `amber attach <n>` resolves. Absent/0 from an older daemon.
  slot?: number
  // Supervision phase for an AGENT session (all supervised kinds): 'claude'
  // (running), 'claude-retrying' (crashed, retrying), 'shell-fallback' (dropped
  // to a shell), 'suspended' (parked, RAM freed). The strings stay spelled
  // `claude*` for every agent — they name the phase, not the binary. Optional on
  // the wire (serde default None → undefined); decode-only, forwarded wholesale
  // through the client → renderer hops.
  run_state?: string | undefined
  // Last agent conversation id recorded for this pane — claude's rotating id
  // (from its SessionStart hook) or the uuid amber assigned a grok session.
  // Powers the "reload claude" action (resume this exact conversation).
  // Optional on the wire (serde default None → undefined); decode-only.
  claude_id?: string | undefined
}

export type ControlMsg =
  | { kind: 'Hello' }
  | { kind: 'ListSessions' }
  | { kind: 'WatchSessions' }
  | { kind: 'WatchMemoryPressure'; version: number }
  | { kind: 'ListSessionsDetailed' }
  | { kind: 'Snapshot' }
  | { kind: 'SnapshotOk' }
  | { kind: 'Create'; name: string; cwd: string; sessionKind: string }
  // `resume` carries the client's delta-replay watermark. Its KEY PRESENCE is
  // the opt-in to `AttachBacklog` replies: `{ epoch: '0', offset: 0 }` means
  // "new-style client, no watermark yet" (0 is reserved — rings never mint
  // it). The epoch is a STRING because it is a nanos-scale u64 that exceeds
  // JS Number's 2^53 precision; a rounded value would never match again and
  // silently disable delta replay.
  | { kind: 'Attach'; name: string; resume?: { epoch: string; offset: number } }
  // Daemon -> client reply to a resume-carrying Attach: the next ONE Data
  // frame is the replay — `full` true = whole scrollback (terminal must reset
  // first; stale epoch or evicted offset), false = only the missing tail.
  // epoch/end_offset are the client's next watermark once that frame plus all
  // following live bytes are consumed. Decode-only: sent only to clients that
  // opted in via `resume`.
  | { kind: 'AttachBacklog'; name: string; epoch: string; end_offset: number; full: boolean }
  | { kind: 'Detach'; name: string }
  | { kind: 'Focus'; name: string }
  | { kind: 'DumpBacklog'; name: string }
  | { kind: 'SearchScrollback'; request_id: number; query: string; names: string[]; limit: number }
  | { kind: 'SearchResults'; request_id: number; query: string; results: SearchResult[] }
  | { kind: 'Backlog'; name: string; data: Uint8Array }
  | { kind: 'Kill'; name: string }
  | { kind: 'Rename'; from: string; to: string }
  | { kind: 'Suspend'; name: string }
  | { kind: 'Resume'; name: string }
  | { kind: 'Resize'; name: string; cols: number; rows: number }
  // Aggregate memory budget (see shared/budget.ts for the display side).
  // `mb` is MiB; 0 = auto (half of physical RAM, capped by the service cap).
  | { kind: 'SetMemoryBudget'; mb: number }
  | { kind: 'GetMemoryBudget' }
  // Daemon reply to both. Numeric fields default to 0 = absent on the wire.
  | { kind: 'BudgetApplied'; mb: number; effective_budget_kb: number; cgroup_limit_kb: number; session_high_kb: number }
  | { kind: 'SessionList'; names: string[] }
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Activity'; name: string }
  | { kind: 'MemoryStat'; name: string; rss_kb: number; growing: boolean }
  | { kind: 'MemoryPressure'; level: 'normal' | 'warning' | 'critical'; current_kb: number; budget_kb: number; blocked: boolean }
  | { kind: 'ResourcePressure'; level: 'normal' | 'critical'; causes: Array<'cpu' | 'io' | 'memory'>; blocked: boolean }
  | { kind: 'Created'; name: string }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }

export type Frame =
  | { type: 'control'; msg: ControlMsg }
  | { type: 'data'; session: string; bytes: Uint8Array }
  // One-shot scrollback dump (reply to DumpBacklog). Its own binary tag, same
  // body layout as `data` — it used to ride ControlMsg.Backlog, whose serde
  // encoding is a JSON numeric array, so a 2 MiB ring arrived as ~8 MB of text
  // and was parsed into a 2-million-element Array before Uint8Array.from.
  // Separate from `data` because `data` is pty output bound for a terminal; a
  // dump is a reply and must never be written into the pane.
  | { type: 'backlog'; session: string; bytes: Uint8Array }

const TAG_CONTROL = 0
const TAG_DATA = 1
const TAG_BACKLOG = 2
const MAX_FRAME_LEN = 64 * 1024 * 1024

// ControlMsg <-> serde-externally-tagged JSON value.
function msgToJson(m: ControlMsg): unknown {
  switch (m.kind) {
    case 'Hello':
    case 'ListSessions':
    case 'WatchSessions':
    case 'ListSessionsDetailed':
    case 'Snapshot':
    case 'SnapshotOk':
      return m.kind // unit variant -> bare string
    case 'WatchMemoryPressure':
      return { WatchMemoryPressure: { version: m.version } }
    case 'Create':
      return { Create: { name: m.name, cwd: m.cwd, kind: m.sessionKind } }
    case 'Attach': {
      // `preview` (mosaic tile attach), like `raw_client`, is never set by the
      // Electron app — it always wants the full backlog on a fresh mount — so
      // it is simply omitted; the daemon's `#[serde(default)]` decodes the
      // absence as `false`. `resume` rides whenever the caller supplied one —
      // including `{ epoch: '0' }` for "new-style client, no watermark yet" —
      // because its key presence opts this connection into AttachBacklog.
      const body: Record<string, unknown> = { name: m.name }
      if (m.resume) body['resume'] = m.resume
      return { Attach: body }
    }
    case 'AttachBacklog':
      // Daemon -> client only; never encoded by this app (mirrors MemoryStat).
      return { AttachBacklog: { name: m.name } }
    case 'Detach':
      return { Detach: { name: m.name } }
    case 'Focus':
      return { Focus: { name: m.name } }
    case 'DumpBacklog':
      return { DumpBacklog: { name: m.name } }
    case 'SearchScrollback':
      return { SearchScrollback: { request_id: m.request_id, query: m.query, names: m.names, limit: m.limit } }
    case 'SearchResults':
      return { SearchResults: { request_id: m.request_id, query: m.query, results: m.results } }
    case 'Backlog':
      // serde encodes Vec<u8> as a JSON numeric array (not base64); mirror it.
      return { Backlog: { name: m.name, data: Array.from(m.data) } }
    case 'Kill':
      return { Kill: { name: m.name } }
    case 'Rename':
      return { Rename: { from: m.from, to: m.to } }
    case 'Suspend':
      return { Suspend: { name: m.name } }
    case 'Resume':
      return { Resume: { name: m.name } }
    case 'Resize':
      return { Resize: { name: m.name, cols: m.cols, rows: m.rows } }
    case 'SetMemoryBudget':
      return { SetMemoryBudget: { mb: m.mb } }
    case 'GetMemoryBudget':
      return 'GetMemoryBudget'
    case 'SessionList':
      return { SessionList: { names: m.names } }
    case 'Sessions':
      return { Sessions: { sessions: m.sessions } }
    case 'SessionsChanged':
      return { SessionsChanged: { added: m.added, removed: m.removed } }
    case 'Activity':
      return { Activity: { name: m.name } }
    case 'MemoryPressure':
      return { MemoryPressure: { level: m.level, current_kb: m.current_kb, budget_kb: m.budget_kb, blocked: m.blocked } }
    case 'ResourcePressure':
      return { ResourcePressure: { level: m.level, causes: m.causes, blocked: m.blocked } }
    case 'Created':
      return { Created: { name: m.name } }
    case 'Exit':
      return { Exit: { name: m.name, code: m.code } }
    case 'Error':
      return { Error: { msg: m.msg } }
  }
}

function jsonToMsg(v: unknown): ControlMsg | null {
  if (typeof v === 'string') {
    if (v === 'Hello' || v === 'ListSessions' || v === 'WatchSessions' ||
        v === 'ListSessionsDetailed' || v === 'Snapshot' || v === 'SnapshotOk') {
      return { kind: v }
    }
    return null
  }
  if (v && typeof v === 'object') {
    const [key, body] = Object.entries(v as Record<string, unknown>)[0] as [string, Record<string, unknown>]
    switch (key) {
      case 'Create': return { kind: 'Create', name: body['name'] as string, cwd: body['cwd'] as string, sessionKind: body['kind'] as string }
      case 'WatchMemoryPressure': return { kind: 'WatchMemoryPressure', version: body['version'] as number }
      case 'Attach': {
        const rawResume = body['resume'] as Record<string, unknown> | undefined
        const resume = rawResume
          ? { epoch: String(rawResume['epoch']), offset: Number(rawResume['offset']) }
          : undefined
        return resume
          ? { kind: 'Attach', name: body['name'] as string, resume }
          : { kind: 'Attach', name: body['name'] as string }
      }
      case 'AttachBacklog':
        return {
          kind: 'AttachBacklog',
          name: body['name'] as string,
          epoch: String(body['epoch']),
          end_offset: (body['end_offset'] as number) ?? 0,
          full: body['full'] === true,
        }
      case 'Detach': return { kind: 'Detach', name: body['name'] as string }
      case 'Focus': return { kind: 'Focus', name: body['name'] as string }
      case 'DumpBacklog': return { kind: 'DumpBacklog', name: body['name'] as string }
      case 'SearchScrollback':
        return {
          kind: 'SearchScrollback',
          request_id: numberField(body, 'request_id'),
          query: stringField(body, 'query'),
          names: stringArrayField(body, 'names', []),
          limit: optionalNumberField(body, 'limit', 0),
        }
      case 'SearchResults':
        return {
          kind: 'SearchResults',
          request_id: numberField(body, 'request_id'),
          query: stringField(body, 'query'),
          results: decodeSearchResults(body['results']),
        }
      // serde encodes Vec<u8> as a JSON numeric array; rebuild the Uint8Array.
      case 'Backlog': return { kind: 'Backlog', name: body['name'] as string, data: Uint8Array.from(body['data'] as number[]) }
      case 'Kill': return { kind: 'Kill', name: body['name'] as string }
      case 'Rename': return { kind: 'Rename', from: body['from'] as string, to: body['to'] as string }
      case 'Resize': return { kind: 'Resize', name: body['name'] as string, cols: body['cols'] as number, rows: body['rows'] as number }
      case 'SetMemoryBudget': return { kind: 'SetMemoryBudget', mb: (body['mb'] as number) ?? 0 }
      case 'GetMemoryBudget': return { kind: 'GetMemoryBudget' }
      case 'BudgetApplied':
        return {
          kind: 'BudgetApplied',
          mb: (body['mb'] as number) ?? 0,
          effective_budget_kb: (body['effective_budget_kb'] as number) ?? 0,
          cgroup_limit_kb: (body['cgroup_limit_kb'] as number) ?? 0,
          session_high_kb: (body['session_high_kb'] as number) ?? 0,
        }
      case 'SessionList': return { kind: 'SessionList', names: body['names'] as string[] }
      case 'Sessions': return { kind: 'Sessions', sessions: decodeSessionInfos(body['sessions']) }
      case 'SessionsChanged': return { kind: 'SessionsChanged', added: decodeSessionInfos(body['added']), removed: body['removed'] as string[] }
      case 'Activity': return { kind: 'Activity', name: body['name'] as string }
      case 'MemoryStat': return { kind: 'MemoryStat', name: body['name'] as string, rss_kb: (body['rss_kb'] as number) ?? 0, growing: (body['growing'] as boolean) ?? false }
      case 'MemoryPressure': {
        const level = body['level']
        if (level !== 'normal' && level !== 'warning' && level !== 'critical') {
          throw new Error(`invalid pressure level: ${String(level)}`)
        }
        return {
          kind: 'MemoryPressure',
          level,
          current_kb: (body['current_kb'] as number) ?? 0,
          budget_kb: (body['budget_kb'] as number) ?? 0,
          blocked: (body['blocked'] as boolean) ?? false,
        }
      }
      case 'ResourcePressure': {
        const level = body['level']
        if (level !== 'normal' && level !== 'critical') {
          throw new Error(`invalid resource pressure level: ${String(level)}`)
        }
        const causes = body['causes']
        if (!Array.isArray(causes) || !causes.every((cause) => cause === 'cpu' || cause === 'io' || cause === 'memory')) {
          throw new Error(`invalid resource pressure cause: ${String(causes)}`)
        }
        return { kind: 'ResourcePressure', level, causes: [...causes] as Array<'cpu' | 'io' | 'memory'>, blocked: (body['blocked'] as boolean) ?? false }
      }
      case 'Created': return { kind: 'Created', name: body['name'] as string }
      case 'Exit': return { kind: 'Exit', name: body['name'] as string, code: body['code'] as number }
      case 'Error': return { kind: 'Error', msg: body['msg'] as string }
      default: return null
    }
  }
  throw new Error('malformed control value')
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string') throw new Error(`invalid ${key}`)
  return value
}

function numberField(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${key}`)
  return value
}

function optionalNumberField(body: Record<string, unknown>, key: string, fallback: number): number {
  return body[key] === undefined ? fallback : numberField(body, key)
}

function stringArrayField(body: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = body[key]
  if (value === undefined) return fallback
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error(`invalid ${key}`)
  return [...value]
}

function decodeSearchResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) throw new Error('invalid search results')
  return value.map((result) => {
    if (!result || typeof result !== 'object') throw new Error('invalid search result')
    const body = result as Record<string, unknown>
    return {
      name: stringField(body, 'name'),
      line: numberField(body, 'line'),
      preview: stringField(body, 'preview'),
    }
  })
}

function decodeSessionInfos(value: unknown): SessionInfo[] {
  if (!Array.isArray(value)) throw new Error('invalid sessions payload')
  return value.map((session) => {
    if (!session || typeof session !== 'object' || !isDaemonSessionKind((session as Record<string, unknown>)['kind'])) {
      throw new Error('invalid session kind')
    }
    return session as SessionInfo
  })
}

export function encode(frame: Frame): Uint8Array {
  let body: Uint8Array
  if (frame.type === 'control') {
    const json = new TextEncoder().encode(JSON.stringify(msgToJson(frame.msg)))
    body = new Uint8Array(1 + json.length)
    body[0] = TAG_CONTROL
    body.set(json, 1)
  } else {
    const name = new TextEncoder().encode(frame.session)
    body = new Uint8Array(1 + 2 + name.length + frame.bytes.length)
    body[0] = frame.type === 'data' ? TAG_DATA : TAG_BACKLOG
    new DataView(body.buffer).setUint16(1, name.length, false)
    body.set(name, 3)
    body.set(frame.bytes, 3 + name.length)
  }
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

// Growth headroom for the accumulation buffer. Doubling (clamped to what is
// actually needed) keeps feed() amortized O(1) per byte.
const DECODER_MIN_CAPACITY = 64 * 1024

/**
 * Streaming frame decoder. Bytes accumulate in a buffer with an explicit read
 * cursor; `next()` returns frames as they complete.
 *
 * The cursor is not a micro-optimisation. The previous form allocated a whole
 * new `Uint8Array` of (buffered + chunk) on EVERY socket chunk, which made
 * assembling one large frame quadratic: measured, a 2 MiB Attach backlog
 * arriving in 64 KiB chunks copied **36.7 MB** through the allocator to receive
 * 2 MB. Every pane's output flows through here in the utilityProcess, so that
 * was the app's single largest source of garbage.
 *
 * Two rules keep it honest, both covered by tests:
 * - consumed bytes are actually reclaimed (a cursor alone would retain every
 *   frame ever received — a leak, not a fix);
 * - the frame payload is still COPIED out, never a view onto the shared buffer.
 *   A view would alias bytes that later frames overwrite during compaction, and
 *   these arrays are handed straight to xterm and across MessagePorts.
 */
export class Decoder {
  private buf = new Uint8Array(0)
  // Bytes before this offset are consumed; bytes in [read, write) are pending.
  private read = 0
  private write = 0

  feed(chunk: Uint8Array): void {
    this.reserve(chunk.length)
    this.buf.set(chunk, this.write)
    this.write += chunk.length
  }

  /** Pending (received, not yet decoded) bytes. Observable so the reclaim rule is testable. */
  buffered(): number {
    return this.write - this.read
  }

  /** Make room for `additional` bytes, reclaiming consumed space first. */
  private reserve(additional: number): void {
    if (this.write + additional <= this.buf.length) return
    const pending = this.write - this.read
    // Sliding the pending bytes down is enough whenever consumed space covers
    // the request — the common steady state, and it allocates nothing.
    if (pending + additional <= this.buf.length) {
      this.buf.copyWithin(0, this.read, this.write)
      this.read = 0
      this.write = pending
      return
    }
    const cap = Math.max(DECODER_MIN_CAPACITY, this.buf.length * 2, pending + additional)
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(this.read, this.write), 0)
    this.buf = next
    this.read = 0
    this.write = pending
  }

  next(): Frame | null {
    for (;;) {
      const next = this.nextOne()
      if (next !== SKIP_CONTROL) return next
    }
  }

  private nextOne(): Frame | typeof SKIP_CONTROL | null {
    if (this.buffered() < 4) return null
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.length)
    const len = view.getUint32(this.read, false)
    if (len > MAX_FRAME_LEN) throw new Error(`frame length ${len} exceeds max`)
    if (this.buffered() < 4 + len) return null
    const body = this.read + 4 // first byte of the body (the tag)
    const end = body + len
    this.read = end
    // Fully drained: reset to the front so a quiet connection holds no cursor
    // drift and the next feed() needs no compaction.
    if (this.read === this.write) { this.read = 0; this.write = 0 }

    const tag = this.buf[body]
    if (tag === TAG_CONTROL) {
      const json = new TextDecoder().decode(this.buf.subarray(body + 1, end))
      const msg = jsonToMsg(JSON.parse(json))
      return msg === null ? SKIP_CONTROL : { type: 'control', msg }
    }
    if (tag === TAG_DATA || tag === TAG_BACKLOG) {
      // Bounds-check the name header against THIS frame, mirroring the Rust
      // decoder's "truncated data frame" bails. The read buffer is over-sized
      // for reuse, so without these a corrupt length prefix would read past the
      // frame into unrelated (or uninitialised) bytes and yield a garbage
      // session name instead of an error.
      if (end - body < 3) throw new Error('truncated data frame header')
      const nameLen = view.getUint16(body + 1, false)
      const nameEnd = body + 3 + nameLen
      if (nameEnd > end) throw new Error('truncated data frame name')
      const session = new TextDecoder().decode(this.buf.subarray(body + 3, nameEnd))
      // slice(), not subarray(): the payload outlives this call (it is posted to
      // the renderer), and the shared buffer is reused by later frames.
      const bytes = this.buf.slice(nameEnd, end)
      return { type: tag === TAG_DATA ? 'data' : 'backlog', session, bytes }
    }
    throw new Error(`unknown frame tag ${tag}`)
  }
}

const SKIP_CONTROL = Symbol('skip-control')
