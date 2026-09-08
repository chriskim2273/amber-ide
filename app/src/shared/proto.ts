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

export interface RecoveryEvent {
  at: number
  sequence: number
  level: string
  event: string
  session?: string
  detail: string
  code?: number
}

export interface SessionInfo {
  name: string
  cwd: string
  kind: DaemonSessionKind
  alive: boolean
  /** User-chosen friendly title, separate from the name/grouping identity. */
  title?: string | undefined
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

/**
 * One quota window as the provider reports it. `percent` is USED, 0..100 —
 * the UI derives "remaining" (see shared/usageView.ts). Amber never computes a
 * percentage of its own.
 */
export interface Gauge {
  kind: string
  label: string
  percent: number
  /** Unix seconds, or null when the provider omits it. */
  resets_at: number | null
  /** The window rolled since this sample: render as words, never the number. */
  stale: boolean
}

/** One provider's quota snapshot. Anything but state 'ok' renders as words. */
export interface ProviderUsage {
  provider: string
  plan: string | null
  gauges: Gauge[]
  updated: number
  state: 'ok' | 'unavailable' | 'needs-auth' | 'error' | string
  detail: string | null
}

export type PiDelivery = 'now' | 'steer' | 'follow_up'

// Keep these values aligned with amber-core::proto. They are exported so
// browser/renderer upload code can reject a file before it allocates a large
// base64 string, while the daemon remains the authoritative second check.
export const PI_PROMPT_MAX_BYTES = 64 * 1024
export const PI_REQUEST_ID_MAX_BYTES = 128
export const PI_SUBAGENT_ID_MAX_BYTES = 256
export const PI_SUBAGENT_INDEX_MAX = 500
export const PI_ATTACHMENT_ID_MAX_BYTES = 128
export const PI_FILENAME_MAX_CHARS = 255
export const PI_MIME_TYPE_MAX_BYTES = 128
export const PI_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024
export const PI_ATTACHMENTS_PER_PROMPT = 8
export const PI_PROMPT_ATTACHMENTS_MAX_BYTES = 32 * 1024 * 1024
export const PI_PENDING_UPLOADS_MAX = 4
export const PI_ARTIFACTS_MAX_BYTES = 256 * 1024 * 1024
export const PI_UPLOAD_CHUNK_MAX_BYTES = 48 * 1024
export const PI_UPLOAD_CHUNK_MAX_ENCODED_BYTES = Math.ceil(PI_UPLOAD_CHUNK_MAX_BYTES / 3) * 4

export type PiCommand =
  | { kind: 'Snapshot' }
  | { kind: 'Prompt'; message: string; delivery: PiDelivery }
  | { kind: 'PromptWithAttachments'; requestId: string; message: string; delivery: PiDelivery; attachments: string[] }
  | { kind: 'UploadBegin'; requestId: string; filename: string; mimeType: string; size: number }
  | { kind: 'UploadChunk'; requestId: string; attachmentId: string; offset: number; data: string }
  | { kind: 'UploadFinish'; requestId: string; attachmentId: string }
  | { kind: 'UploadCancel'; requestId: string; attachmentId: string }
  | { kind: 'SubagentStatus'; requestId: string }
  | { kind: 'SubagentTranscript'; requestId: string; runId: string; index?: number }
  | { kind: 'SubagentControl'; requestId: string; action: 'stop' | 'steer' | 'interrupt' | 'resume'; runId: string; childId?: string; index?: number; message?: string }
  | { kind: 'Abort' }
  | { kind: 'SetThinkingLevel'; level: string }

export type ControlMsg =
  | { kind: 'Hello' }
  | { kind: 'ListSessions' }
  | { kind: 'WatchSessions' }
  | { kind: 'WatchMemoryPressure'; version: number }
  | { kind: 'WatchPiEvents'; version: number }
  | { kind: 'PiBridgeHello'; name: string }
  | { kind: 'PiBridgeCommand'; name: string; command: PiCommand }
  | { kind: 'PiEvent'; name: string; seq: number; event: Record<string, unknown> }
  | { kind: 'PiBridgeStatus'; name: string; available: boolean }
  | { kind: 'ListSessionsDetailed' }
  | { kind: 'Snapshot' }
  | { kind: 'SnapshotOk' }
  | { kind: 'Create'; name: string; cwd: string; sessionKind: string; title?: string | undefined }
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
  | { kind: 'ListRecoveryEvents'; limit: number }
  | { kind: 'ClearRecoveryEvents' }
  | { kind: 'RecoveryEvents'; events: RecoveryEvent[] }
  | { kind: 'RecoveryEventsCleared' }
  | { kind: 'Backlog'; name: string; data: Uint8Array }
  | { kind: 'Kill'; name: string }
  | { kind: 'Rename'; from: string; to: string }
  | { kind: 'SetTitle'; name: string; title: string | null }
  /** Daemon acknowledgement emitted after a title is persisted. */
  | { kind: 'TitleSet'; name: string; title: string | null }
  | { kind: 'Suspend'; name: string }
  | { kind: 'Resume'; name: string }
  | { kind: 'Resize'; name: string; cols: number; rows: number }
  // Agent plan quota (design 2026-09-01). GetUsage is a request; the daemon
  // answers from its 60 s poller cache with Usage.
  | { kind: 'GetUsage' }
  | { kind: 'RefreshUsage' }
  | { kind: 'Usage'; providers: ProviderUsage[] }
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
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })

// ControlMsg <-> serde-externally-tagged JSON value.
function msgToJson(m: ControlMsg): unknown {
  switch (m.kind) {
    case 'Hello':
    case 'ListSessions':
    case 'WatchSessions':
    case 'ListSessionsDetailed':
    case 'Snapshot':
    case 'SnapshotOk':
    case 'ClearRecoveryEvents':
    case 'RecoveryEventsCleared':
      return m.kind // unit variant -> bare string
    case 'WatchMemoryPressure':
      return { WatchMemoryPressure: { version: m.version } }
    case 'WatchPiEvents':
      return { WatchPiEvents: { version: m.version } }
    case 'PiBridgeHello':
      return { PiBridgeHello: { name: m.name } }
    case 'PiBridgeCommand':
      return { PiBridgeCommand: { name: m.name, command: piCommandToJson(m.command) } }
    case 'PiEvent':
      return { PiEvent: { name: m.name, seq: m.seq, event: m.event } }
    case 'PiBridgeStatus':
      return { PiBridgeStatus: { name: m.name, available: m.available } }
    case 'Create':
      return { Create: { name: m.name, cwd: m.cwd, kind: m.sessionKind, ...(m.title === undefined ? {} : { title: m.title }) } }
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
    case 'ListRecoveryEvents':
      return { ListRecoveryEvents: { limit: m.limit } }
    case 'RecoveryEvents':
      return { RecoveryEvents: { events: m.events } }
    case 'Backlog':
      // serde encodes Vec<u8> as a JSON numeric array (not base64); mirror it.
      return { Backlog: { name: m.name, data: Array.from(m.data) } }
    case 'Kill':
      return { Kill: { name: m.name } }
    case 'Rename':
      return { Rename: { from: m.from, to: m.to } }
    case 'SetTitle':
      return { SetTitle: { name: m.name, title: m.title } }
    case 'TitleSet':
      return { TitleSet: { name: m.name, title: m.title } }
    case 'Suspend':
      return { Suspend: { name: m.name } }
    case 'Resume':
      return { Resume: { name: m.name } }
    case 'Resize':
      return { Resize: { name: m.name, cols: m.cols, rows: m.rows } }
    case 'GetUsage':
      return 'GetUsage'
    case 'RefreshUsage':
      return 'RefreshUsage'
    case 'Usage':
      return { Usage: { providers: m.providers } }
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

function decodeGauge(v: unknown): Gauge {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    kind: typeof o['kind'] === 'string' ? o['kind'] : '',
    label: typeof o['label'] === 'string' ? o['label'] : '',
    percent: typeof o['percent'] === 'number' ? o['percent'] : 0,
    resets_at: typeof o['resets_at'] === 'number' ? o['resets_at'] : null,
    stale: o['stale'] === true,
  }
}

/**
 * Tolerant by design: every field but `provider`/`state` is serde-defaulted on
 * the Rust side, and the same decoder serves the web build's `/api/usage`
 * body, which is JSON from a route rather than a typed frame.
 */
export function decodeProviderUsage(v: unknown): ProviderUsage {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    provider: typeof o['provider'] === 'string' ? o['provider'] : '',
    plan: typeof o['plan'] === 'string' ? o['plan'] : null,
    gauges: Array.isArray(o['gauges']) ? (o['gauges'] as unknown[]).map(decodeGauge) : [],
    updated: typeof o['updated'] === 'number' ? o['updated'] : 0,
    state: typeof o['state'] === 'string' ? o['state'] : 'unavailable',
    detail: typeof o['detail'] === 'string' ? o['detail'] : null,
  }
}

function piCommandToJson(command: PiCommand): unknown {
  switch (command.kind) {
    case 'Snapshot':
    case 'Abort': return command.kind
    case 'Prompt': return { Prompt: { message: command.message, delivery: command.delivery } }
    case 'PromptWithAttachments': return {
      PromptWithAttachments: {
        requestId: command.requestId,
        message: command.message,
        delivery: command.delivery,
        attachments: command.attachments,
      },
    }
    case 'UploadBegin': return {
      UploadBegin: {
        requestId: command.requestId,
        filename: command.filename,
        mimeType: command.mimeType,
        size: command.size,
      },
    }
    case 'UploadChunk': return {
      UploadChunk: {
        requestId: command.requestId,
        attachmentId: command.attachmentId,
        offset: command.offset,
        data: command.data,
      },
    }
    case 'UploadFinish': return {
      UploadFinish: { requestId: command.requestId, attachmentId: command.attachmentId },
    }
    case 'UploadCancel': return {
      UploadCancel: { requestId: command.requestId, attachmentId: command.attachmentId },
    }
    case 'SubagentStatus': return { SubagentStatus: { requestId: command.requestId } }
    case 'SubagentTranscript': return {
      SubagentTranscript: {
        requestId: command.requestId,
        runId: command.runId,
        ...(command.index === undefined ? {} : { index: command.index }),
      },
    }
    case 'SubagentControl': return {
      SubagentControl: {
        requestId: command.requestId,
        action: command.action,
        runId: command.runId,
        ...(command.childId === undefined ? {} : { childId: command.childId }),
        ...(command.index === undefined ? {} : { index: command.index }),
        ...(command.message === undefined ? {} : { message: command.message }),
      },
    }
    case 'SetThinkingLevel': return { SetThinkingLevel: { level: command.level } }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function piString(body: Record<string, unknown>, key: string): string | null {
  return typeof body[key] === 'string' ? body[key] as string : null
}

function isPiControl(char: string): boolean {
  const code = char.codePointAt(0)!
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

function validPiRequestId(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).length <= PI_REQUEST_ID_MAX_BYTES
    && ![...value].some(isPiControl)
}

function validPiSubagentId(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).length <= PI_SUBAGENT_ID_MAX_BYTES
    && ![...value].some((char) => isPiControl(char) || /[\\/\s]/.test(char))
}

function validPiSubagentIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= PI_SUBAGENT_INDEX_MAX
}

function validPiAttachmentId(value: string): boolean {
  return value.length > 0 && value.length <= PI_ATTACHMENT_ID_MAX_BYTES && /^[A-Za-z0-9_-]+$/.test(value)
}

function validPiFilename(value: string): boolean {
  return value.length > 0 && [...value].length <= PI_FILENAME_MAX_CHARS
    && ![...value].some((char) => isPiControl(char) || char === '/' || char === '\\')
}

function validPiMimeType(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).length <= PI_MIME_TYPE_MAX_BYTES
    && ![...value].some(isPiControl)
}

function validPiSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= PI_ATTACHMENT_MAX_BYTES
}

function validCanonicalBase64(value: string): boolean {
  if (!value || value.length > PI_UPLOAD_CHUNK_MAX_ENCODED_BYTES || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const last = value.slice(-4)
  const decode = (char: string): number => {
    if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 65
    if (char >= 'a' && char <= 'z') return char.charCodeAt(0) - 71
    if (char >= '0' && char <= '9') return char.charCodeAt(0) + 4
    return char === '+' ? 62 : 63
  }
  if (last[2] === '=' && (decode(last[1]!) & 0x0f) !== 0) return false
  if (last[3] === '=' && last[2] !== '=' && (decode(last[2]!) & 0x03) !== 0) return false
  return true
}

function jsonToPiCommand(v: unknown): PiCommand | null {
  if (v === 'Snapshot' || v === 'Abort') return { kind: v }
  if (!isRecord(v)) return null
  const entries = Object.entries(v)
  if (entries.length !== 1) return null
  const entry = entries[0]
  if (!entry) return null
  const [kind, rawBody] = entry
  if (!isRecord(rawBody)) return null
  const body = rawBody
  if (kind === 'Prompt') {
    const message = piString(body, 'message')
    const delivery = body['delivery']
    if (message === null || message.trim().length === 0 || (delivery !== 'now' && delivery !== 'steer' && delivery !== 'follow_up')
      || new TextEncoder().encode(message).length > PI_PROMPT_MAX_BYTES) return null
    return { kind: 'Prompt', message, delivery }
  }
  if (kind === 'PromptWithAttachments') {
    const requestId = piString(body, 'requestId')
    const message = piString(body, 'message')
    const delivery = body['delivery']
    const rawAttachments = body['attachments']
    if (requestId === null || !validPiRequestId(requestId) || message === null
      || new TextEncoder().encode(message).length > PI_PROMPT_MAX_BYTES
      || (delivery !== 'now' && delivery !== 'steer' && delivery !== 'follow_up')
      || !Array.isArray(rawAttachments) || rawAttachments.length > PI_ATTACHMENTS_PER_PROMPT
      || !rawAttachments.every((entry) => typeof entry === 'string' && validPiAttachmentId(entry))
      || new Set(rawAttachments).size !== rawAttachments.length
      || (message.trim().length === 0 && rawAttachments.length === 0)) return null
    return { kind: 'PromptWithAttachments', requestId, message, delivery, attachments: [...rawAttachments] }
  }
  if (kind === 'UploadBegin') {
    const requestId = piString(body, 'requestId')
    const filename = piString(body, 'filename')
    const mimeType = piString(body, 'mimeType')
    if (requestId === null || !validPiRequestId(requestId) || filename === null || !validPiFilename(filename)
      || mimeType === null || !validPiMimeType(mimeType) || !validPiSize(body['size'])) return null
    return { kind: 'UploadBegin', requestId, filename, mimeType, size: body['size'] }
  }
  if (kind === 'UploadChunk') {
    const requestId = piString(body, 'requestId')
    const attachmentId = piString(body, 'attachmentId')
    const data = piString(body, 'data')
    if (requestId === null || !validPiRequestId(requestId) || attachmentId === null || !validPiAttachmentId(attachmentId)
      || !validPiSize(body['offset']) || data === null || !validCanonicalBase64(data)) return null
    return { kind: 'UploadChunk', requestId, attachmentId, offset: body['offset'], data }
  }
  if (kind === 'UploadFinish' || kind === 'UploadCancel') {
    const requestId = piString(body, 'requestId')
    const attachmentId = piString(body, 'attachmentId')
    if (requestId === null || !validPiRequestId(requestId) || attachmentId === null || !validPiAttachmentId(attachmentId)) return null
    return kind === 'UploadFinish'
      ? { kind: 'UploadFinish', requestId, attachmentId }
      : { kind: 'UploadCancel', requestId, attachmentId }
  }
  if (kind === 'SubagentStatus') {
    const requestId = piString(body, 'requestId')
    if (requestId === null || !validPiRequestId(requestId)) return null
    return { kind: 'SubagentStatus', requestId }
  }
  if (kind === 'SubagentTranscript') {
    const requestId = piString(body, 'requestId')
    const runId = piString(body, 'runId')
    const rawIndex = body['index']
    if (requestId === null || !validPiRequestId(requestId) || runId === null || !validPiSubagentId(runId)
      || (rawIndex !== undefined && !validPiSubagentIndex(rawIndex))) return null
    return { kind: 'SubagentTranscript', requestId, runId, ...(rawIndex === undefined ? {} : { index: rawIndex }) }
  }
  if (kind === 'SubagentControl') {
    const requestId = piString(body, 'requestId')
    const action = body['action']
    const runId = piString(body, 'runId')
    const childId = body['childId']
    const rawIndex = body['index']
    const message = body['message']
    if (requestId === null || !validPiRequestId(requestId) || !['stop', 'steer', 'interrupt', 'resume'].includes(action as string)
      || runId === null || !validPiSubagentId(runId)
      || (childId !== undefined && (typeof childId !== 'string' || !validPiSubagentId(childId)))
      || (rawIndex !== undefined && !validPiSubagentIndex(rawIndex))
      || (message !== undefined && (typeof message !== 'string' || new TextEncoder().encode(message).length > PI_PROMPT_MAX_BYTES))) return null
    if (action !== 'stop' && action !== 'interrupt' && (typeof message !== 'string' || message.trim().length === 0)) return null
    if (childId !== undefined || rawIndex !== undefined) return null
    if ((action === 'stop' || action === 'interrupt') && message !== undefined) return null
    return {
      kind: 'SubagentControl', requestId, action: action as 'stop' | 'steer' | 'interrupt' | 'resume', runId,
      ...(childId === undefined ? {} : { childId }), ...(rawIndex === undefined ? {} : { index: rawIndex }),
      ...(message === undefined ? {} : { message }),
    }
  }
  if (kind === 'SetThinkingLevel') {
    const level = piString(body, 'level')
    if (level !== null && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
      return { kind: 'SetThinkingLevel', level }
    }
  }
  return null
}

function jsonToMsg(v: unknown): ControlMsg | null {
  if (typeof v === 'string') {
    if (v === 'Hello' || v === 'ListSessions' || v === 'WatchSessions' ||
        v === 'ListSessionsDetailed' || v === 'Snapshot' || v === 'SnapshotOk' ||
        v === 'ClearRecoveryEvents' || v === 'RecoveryEventsCleared' ||
        v === 'GetUsage' || v === 'RefreshUsage') {
      return { kind: v }
    }
    return null
  }
  if (v && typeof v === 'object') {
    const [key, body] = Object.entries(v as Record<string, unknown>)[0] as [string, Record<string, unknown>]
    switch (key) {
      case 'Create': return {
        kind: 'Create', name: body['name'] as string, cwd: body['cwd'] as string,
        sessionKind: body['kind'] as string,
        ...(body['title'] === undefined ? {} : { title: typeof body['title'] === 'string' ? body['title'] : undefined }),
      }
      case 'WatchMemoryPressure': return { kind: 'WatchMemoryPressure', version: body['version'] as number }
      case 'WatchPiEvents': return { kind: 'WatchPiEvents', version: body['version'] as number }
      case 'PiBridgeHello': return { kind: 'PiBridgeHello', name: body['name'] as string }
      case 'PiBridgeCommand': {
        const command = jsonToPiCommand(body['command'])
        return command ? { kind: 'PiBridgeCommand', name: body['name'] as string, command } : null
      }
      case 'PiEvent': {
        const event = body['event']
        if (!event || typeof event !== 'object' || Array.isArray(event)) return null
        return { kind: 'PiEvent', name: body['name'] as string, seq: body['seq'] as number, event: event as Record<string, unknown> }
      }
      case 'PiBridgeStatus': return { kind: 'PiBridgeStatus', name: body['name'] as string, available: body['available'] === true }
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
      case 'ListRecoveryEvents':
        return { kind: 'ListRecoveryEvents', limit: optionalNumberField(body, 'limit', 0) }
      case 'RecoveryEvents':
        return { kind: 'RecoveryEvents', events: decodeRecoveryEvents(body['events']) }
      // serde encodes Vec<u8> as a JSON numeric array; rebuild the Uint8Array.
      case 'Backlog': return { kind: 'Backlog', name: body['name'] as string, data: Uint8Array.from(body['data'] as number[]) }
      case 'Kill': return { kind: 'Kill', name: body['name'] as string }
      case 'Rename': return { kind: 'Rename', from: body['from'] as string, to: body['to'] as string }
      case 'SetTitle': return {
        kind: 'SetTitle', name: body['name'] as string,
        title: body['title'] === null ? null : typeof body['title'] === 'string' ? body['title'] : null,
      }
      case 'TitleSet': return {
        kind: 'TitleSet', name: body['name'] as string,
        title: body['title'] === null ? null : typeof body['title'] === 'string' ? body['title'] : null,
      }
      case 'Resize': return { kind: 'Resize', name: body['name'] as string, cols: body['cols'] as number, rows: body['rows'] as number }
      case 'Usage': {
        const raw = Array.isArray(body['providers']) ? (body['providers'] as unknown[]) : []
        return { kind: 'Usage', providers: raw.map(decodeProviderUsage) }
      }
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

function decodeRecoveryEvents(value: unknown): RecoveryEvent[] {
  if (!Array.isArray(value)) throw new Error('invalid recovery events')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid recovery event')
    const body = entry as Record<string, unknown>
    const session = body['session']
    const code = body['code']
    if (session !== undefined && typeof session !== 'string') throw new Error('invalid recovery session')
    if (code !== undefined && (typeof code !== 'number' || !Number.isFinite(code))) throw new Error('invalid recovery code')
    return {
      at: numberField(body, 'at'),
      sequence: optionalNumberField(body, 'sequence', 0),
      level: stringField(body, 'level'),
      event: stringField(body, 'event'),
      ...(session === undefined ? {} : { session }),
      detail: stringField(body, 'detail'),
      ...(code === undefined ? {} : { code }),
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
      const json = FATAL_UTF8.decode(this.buf.subarray(body + 1, end))
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
      const session = FATAL_UTF8.decode(this.buf.subarray(body + 3, nameEnd))
      // slice(), not subarray(): the payload outlives this call (it is posted to
      // the renderer), and the shared buffer is reused by later frames.
      const bytes = this.buf.slice(nameEnd, end)
      return { type: tag === TAG_DATA ? 'data' : 'backlog', session, bytes }
    }
    throw new Error(`unknown frame tag ${tag}`)
  }
}

const SKIP_CONTROL = Symbol('skip-control')
