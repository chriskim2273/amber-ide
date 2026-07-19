// TS port of amber-core::proto. Wire: [u32 BE body_len][u8 tag][body].
// tag 0 = Control (JSON of ControlMsg, serde externally-tagged).
// tag 1 = Data ([u16 BE name_len][name utf8][raw bytes]).

export interface SessionInfo {
  name: string
  cwd: string
  kind: string
  alive: boolean
  // Unix seconds of the session's last state-store write; the daemon's
  // ordering key for "most recent". Optional on the wire (serde default 0);
  // the app does not use it today.
  updated?: number
  // Claude supervision phase for a claude session: 'claude' (running),
  // 'claude-retrying' (crashed, retrying), 'shell-fallback' (dropped to a
  // shell). Optional on the wire (serde default None → undefined); decode-only,
  // forwarded wholesale through the client → renderer hops.
  run_state?: string | undefined
  // Last Claude Code session id recorded for this pane (SessionStart hook), if
  // any. Powers the "reload claude" action (resume this exact conversation).
  // Optional on the wire (serde default None → undefined); decode-only.
  claude_id?: string | undefined
}

export type ControlMsg =
  | { kind: 'Hello' }
  | { kind: 'ListSessions' }
  | { kind: 'WatchSessions' }
  | { kind: 'ListSessionsDetailed' }
  | { kind: 'Snapshot' }
  | { kind: 'SnapshotOk' }
  | { kind: 'Create'; name: string; cwd: string; sessionKind: string }
  | { kind: 'Attach'; name: string }
  | { kind: 'Detach'; name: string }
  | { kind: 'DumpBacklog'; name: string }
  | { kind: 'Backlog'; name: string; data: Uint8Array }
  | { kind: 'Kill'; name: string }
  | { kind: 'Rename'; from: string; to: string }
  | { kind: 'Suspend'; name: string }
  | { kind: 'Resume'; name: string }
  | { kind: 'Resize'; name: string; cols: number; rows: number }
  | { kind: 'SessionList'; names: string[] }
  | { kind: 'Sessions'; sessions: SessionInfo[] }
  | { kind: 'SessionsChanged'; added: SessionInfo[]; removed: string[] }
  | { kind: 'Activity'; name: string }
  | { kind: 'MemoryStat'; name: string; rss_kb: number; growing: boolean }
  | { kind: 'Created'; name: string }
  | { kind: 'Exit'; name: string; code: number }
  | { kind: 'Error'; msg: string }

export type Frame =
  | { type: 'control'; msg: ControlMsg }
  | { type: 'data'; session: string; bytes: Uint8Array }

const TAG_CONTROL = 0
const TAG_DATA = 1
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
    case 'Create':
      return { Create: { name: m.name, cwd: m.cwd, kind: m.sessionKind } }
    case 'Attach':
      return { Attach: { name: m.name } }
    case 'Detach':
      return { Detach: { name: m.name } }
    case 'DumpBacklog':
      return { DumpBacklog: { name: m.name } }
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
    case 'SessionList':
      return { SessionList: { names: m.names } }
    case 'Sessions':
      return { Sessions: { sessions: m.sessions } }
    case 'SessionsChanged':
      return { SessionsChanged: { added: m.added, removed: m.removed } }
    case 'Activity':
      return { Activity: { name: m.name } }
    case 'Created':
      return { Created: { name: m.name } }
    case 'Exit':
      return { Exit: { name: m.name, code: m.code } }
    case 'Error':
      return { Error: { msg: m.msg } }
  }
}

function jsonToMsg(v: unknown): ControlMsg {
  if (typeof v === 'string') {
    if (v === 'Hello' || v === 'ListSessions' || v === 'WatchSessions' ||
        v === 'ListSessionsDetailed' || v === 'Snapshot' || v === 'SnapshotOk') {
      return { kind: v }
    }
    throw new Error(`unknown unit control: ${v}`)
  }
  if (v && typeof v === 'object') {
    const [key, body] = Object.entries(v as Record<string, unknown>)[0] as [string, Record<string, unknown>]
    switch (key) {
      case 'Create': return { kind: 'Create', name: body['name'] as string, cwd: body['cwd'] as string, sessionKind: body['kind'] as string }
      case 'Attach': return { kind: 'Attach', name: body['name'] as string }
      case 'Detach': return { kind: 'Detach', name: body['name'] as string }
      case 'DumpBacklog': return { kind: 'DumpBacklog', name: body['name'] as string }
      // serde encodes Vec<u8> as a JSON numeric array; rebuild the Uint8Array.
      case 'Backlog': return { kind: 'Backlog', name: body['name'] as string, data: Uint8Array.from(body['data'] as number[]) }
      case 'Kill': return { kind: 'Kill', name: body['name'] as string }
      case 'Rename': return { kind: 'Rename', from: body['from'] as string, to: body['to'] as string }
      case 'Resize': return { kind: 'Resize', name: body['name'] as string, cols: body['cols'] as number, rows: body['rows'] as number }
      case 'SessionList': return { kind: 'SessionList', names: body['names'] as string[] }
      case 'Sessions': return { kind: 'Sessions', sessions: body['sessions'] as SessionInfo[] }
      case 'SessionsChanged': return { kind: 'SessionsChanged', added: body['added'] as SessionInfo[], removed: body['removed'] as string[] }
      case 'Activity': return { kind: 'Activity', name: body['name'] as string }
      case 'MemoryStat': return { kind: 'MemoryStat', name: body['name'] as string, rss_kb: (body['rss_kb'] as number) ?? 0, growing: (body['growing'] as boolean) ?? false }
      case 'Created': return { kind: 'Created', name: body['name'] as string }
      case 'Exit': return { kind: 'Exit', name: body['name'] as string, code: body['code'] as number }
      case 'Error': return { kind: 'Error', msg: body['msg'] as string }
      default: throw new Error(`unknown control: ${key}`)
    }
  }
  throw new Error('malformed control value')
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
    body[0] = TAG_DATA
    new DataView(body.buffer).setUint16(1, name.length, false)
    body.set(name, 3)
    body.set(frame.bytes, 3 + name.length)
  }
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, false)
  out.set(body, 4)
  return out
}

export class Decoder {
  private buf = new Uint8Array(0)

  feed(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf, 0)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  next(): Frame | null {
    if (this.buf.length < 4) return null
    const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, false)
    if (len > MAX_FRAME_LEN) throw new Error(`frame length ${len} exceeds max`)
    if (this.buf.length < 4 + len) return null
    const body = this.buf.slice(4, 4 + len)
    this.buf = this.buf.slice(4 + len)
    const tag = body[0]
    if (tag === TAG_CONTROL) {
      const json = new TextDecoder().decode(body.slice(1))
      return { type: 'control', msg: jsonToMsg(JSON.parse(json)) }
    }
    if (tag === TAG_DATA) {
      const nameLen = new DataView(body.buffer, body.byteOffset + 1, 2).getUint16(0, false)
      const session = new TextDecoder().decode(body.slice(3, 3 + nameLen))
      const bytes = body.slice(3 + nameLen)
      return { type: 'data', session, bytes }
    }
    throw new Error(`unknown frame tag ${tag}`)
  }
}
