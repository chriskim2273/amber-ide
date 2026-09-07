import type { ControlMsg } from '../shared/proto'

export interface PiToolState {
  id: string
  name: string
  args?: unknown
  result?: unknown
  partial?: unknown
  running: boolean
  error?: boolean
}

export interface PiViewState {
  available: boolean
  statusKnown: boolean
  idle: boolean
  pending: boolean
  messages: unknown[]
  liveMessage: unknown | null
  tools: Record<string, PiToolState>
  model: Record<string, unknown> | null
  thinkingLevel: string
  contextUsage: Record<string, unknown> | null
  awaitingUi: { kind: string; title?: string } | null
  error: string | null
  lastSeq: number
}

export const initialPiViewState: PiViewState = {
  available: false,
  statusKnown: false,
  idle: true,
  pending: false,
  messages: [],
  liveMessage: null,
  tools: {},
  model: null,
  thinkingLevel: 'off',
  contextUsage: null,
  awaitingUi: null,
  error: null,
  lastSeq: 0,
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function messagesFromEntries(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return []
  const out: unknown[] = []
  for (const entry of entries) {
    const e = record(entry)
    if (!e) continue
    if (e['type'] === 'message' && record(e['message'])) out.push(e['message'])
  }
  return out
}

function cappedMessages(messages: unknown[], message: unknown): unknown[] {
  return [...messages, message].slice(-500)
}

function updateTool(state: PiViewState, event: Record<string, unknown>, phase: 'start' | 'update' | 'end'): PiViewState {
  const id = typeof event['toolCallId'] === 'string' ? event['toolCallId'] : ''
  if (!id) return state
  const previous = state.tools[id]
  const tool: PiToolState = {
    id,
    name: typeof event['toolName'] === 'string' ? event['toolName'] : previous?.name ?? 'tool',
    ...(event['args'] !== undefined ? { args: event['args'] } : previous?.args !== undefined ? { args: previous.args } : {}),
    ...(event['partialResult'] !== undefined ? { partial: event['partialResult'] } : previous?.partial !== undefined ? { partial: previous.partial } : {}),
    ...(event['result'] !== undefined ? { result: event['result'] } : previous?.result !== undefined ? { result: previous.result } : {}),
    running: phase !== 'end',
    ...(phase === 'end' ? { error: event['isError'] === true } : previous?.error !== undefined ? { error: previous.error } : {}),
  }
  const tools = { ...state.tools, [id]: tool }
  const ids = Object.keys(tools)
  if (ids.length > 100) delete tools[ids[0]!]
  return { ...state, tools }
}

export function reducePiView(state: PiViewState, msg: ControlMsg): PiViewState {
  if (msg.kind === 'PiBridgeStatus') {
    return {
      ...state,
      available: msg.available,
      statusKnown: true,
      // A disappearing extension may restart its sequence at one.
      ...(!msg.available ? { lastSeq: 0, liveMessage: null } : {}),
    }
  }
  if (msg.kind !== 'PiEvent') return state
  const event = msg.event
  const kind = typeof event['kind'] === 'string' ? event['kind'] : ''
  // Snapshots are authoritative reconnect checkpoints and may come from a
  // restarted extension whose sequence restarted below the prior process.
  if (kind !== 'snapshot' && msg.seq <= state.lastSeq) return state
  const base = { ...state, lastSeq: msg.seq, error: null }

  switch (kind) {
    case 'snapshot':
      return {
        ...base,
        available: true,
        statusKnown: true,
        idle: event['idle'] !== false,
        pending: event['pending'] === true,
        messages: messagesFromEntries(event['entries']),
        liveMessage: null,
        tools: {},
        model: record(event['model']),
        thinkingLevel: typeof event['thinkingLevel'] === 'string' ? event['thinkingLevel'] : 'off',
        contextUsage: record(event['contextUsage']),
      }
    case 'agent_start': return { ...base, idle: false }
    case 'agent_end':
    case 'agent_settled': return { ...base, idle: true, pending: false }
    case 'message_start': return { ...base, liveMessage: event['message'] ?? null }
    case 'message_update': return { ...base, liveMessage: event['message'] ?? state.liveMessage }
    case 'message_end': {
      const message = event['message']
      return message === undefined
        ? { ...base, liveMessage: null }
        : { ...base, messages: cappedMessages(state.messages, message), liveMessage: null }
    }
    case 'tool_execution_start': return updateTool(base, event, 'start')
    case 'tool_execution_update': return updateTool(base, event, 'update')
    case 'tool_execution_end': return updateTool(base, event, 'end')
    case 'model_select': return { ...base, model: record(event['model']) }
    case 'thinking_level_select':
      return { ...base, thinkingLevel: typeof event['level'] === 'string' ? event['level'] : state.thinkingLevel }
    case 'ui_prompt_start':
      return {
        ...base,
        awaitingUi: {
          kind: typeof event['eventKind'] === 'string' ? event['eventKind'] : 'prompt',
          ...(typeof event['title'] === 'string' ? { title: event['title'] } : {}),
        },
      }
    case 'ui_prompt_end': return { ...base, awaitingUi: null }
    case 'command_error':
    case 'bridge_error': return { ...base, error: typeof event['message'] === 'string' ? event['message'] : 'Pi bridge error' }
    default: return base
  }
}
