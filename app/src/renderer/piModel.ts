import type { ControlMsg } from '../shared/proto'

const MAX_MESSAGES = 500
const MAX_TOOLS = 128
const MAX_SUBAGENT_RUNS = 64
const MAX_SUBAGENT_CHILDREN = 50
const MAX_SUBAGENT_TRANSCRIPTS = 64
const MAX_TEXT = 4_096

export interface PiToolState {
  id: string
  name: string
  args?: unknown
  result?: unknown
  partial?: unknown
  running: boolean
  error?: boolean
}

export interface PiSubagentCapabilities {
  methods: string[]
  status: boolean
  steer: boolean
  interrupt: boolean
  stop: boolean
  resume: boolean
  nonRecoveringSteer: boolean
}

export interface PiSubagentActivity {
  state?: string
  currentTool?: string
  lastActivityAt?: number
  currentToolStartedAt?: number
  turnCount?: number
  toolCount?: number
}

export interface PiSubagentNode {
  id: string
  label: string
  state: string
  kind?: string
  activity?: PiSubagentActivity
  startedAt?: number
  updatedAt?: number
  endedAt?: number
  children?: PiSubagentNode[]
}

export interface PiSubagentFleetEntry {
  agent: string
  startedAt: number
  role?: string
  model?: string
  effort?: string
  goal?: string
  tokens: Record<string, number>
}

export interface PiSubagentStatus {
  available: boolean
  stale: boolean
  reason?: string
  capabilities: PiSubagentCapabilities
  asyncRuns: PiSubagentNode[]
  fleet: {
    entries: PiSubagentFleetEntry[]
    totalActive: number
    topLevelAsyncCapacity: { used: number; limit: number }
    omitted: number
  }
  omitted: { runs: number; children: number; byteLimitExceeded: boolean }
}

export interface PiSubagentTranscript {
  requestId: string
  runId: string
  index?: number
  text: string
  results: Array<{
    agent?: string
    status?: string
    finalOutput?: string
    messages?: Array<{ text: string; role?: string; kind?: string; name?: string; isError?: boolean }>
  }>
}

export interface PiSubagentReceipt {
  action: string
  runId: string
  state?: string
  childId?: string
  message?: string
  text?: string
  deliveryStatus?: 'queued' | 'delivered'
  sourceRunId?: string
  replacementRunId?: string
  targets?: Array<{ index?: number; state?: string; reason?: string }>
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
  capabilities: { attachments: boolean; promptReceipts: boolean }
  commandResults: Record<string, { command: string; success: boolean; error?: string; data?: unknown }>
  subagents: PiSubagentStatus
  transcripts: Record<string, PiSubagentTranscript>
  receipts: Record<string, PiSubagentReceipt>
  awaitingUi: { kind: string; title?: string } | null
  /** The last durable/bridge error. It is not cleared by unrelated stream
   * events, so a failed command remains actionable until replaced. */
  error: string | null
  lastSeq: number
}

const emptyCapabilities = (): PiSubagentCapabilities => ({
  methods: [], status: false, steer: false, interrupt: false, stop: false, resume: false,
  nonRecoveringSteer: false,
})

const unavailableSubagents = (): PiSubagentStatus => ({
  available: false, stale: true, capabilities: emptyCapabilities(), asyncRuns: [],
  fleet: { entries: [], totalActive: 0, topLevelAsyncCapacity: { used: 0, limit: 0 }, omitted: 0 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
})

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
  capabilities: { attachments: false, promptReceipts: false },
  commandResults: {},
  subagents: unavailableSubagents(),
  transcripts: {},
  receipts: {},
  awaitingUi: null,
  error: null,
  lastSeq: 0,
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Extract the durable message order from an extension snapshot. Unknown
 * entries stay out of the transcript but are not allowed to become markup. */
export function messagesFromEntries(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return []
  const out: unknown[] = []
  for (const entry of entries) {
    const e = record(entry)
    if (!e) continue
    if (e['type'] === 'message' && record(e['message'])) out.push(e['message'])
  }
  return out.slice(-MAX_MESSAGES)
}

function toolEventFromEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  const type = entry['type']
  if (type !== 'tool_execution_start' && type !== 'tool_execution_update' && type !== 'tool_execution_end') return null
  return entry
}

/** Hydrate tool state from snapshots when Pi includes execution entries. This
 * keeps a reconnect checkpoint from losing the compact tool summary. */
export function toolsFromEntries(entries: unknown): Record<string, PiToolState> {
  if (!Array.isArray(entries)) return {}
  const tools: Record<string, PiToolState> = {}
  for (const raw of entries) {
    const entry = record(raw)
    const event = entry ? toolEventFromEntry(entry) : null
    if (!event || typeof event['toolCallId'] !== 'string') continue
    const id = event['toolCallId']
    const previous = tools[id]
    const type = event['type']
    tools[id] = {
      id,
      name: typeof event['toolName'] === 'string' ? event['toolName'] : previous?.name ?? 'tool',
      ...(event['args'] !== undefined ? { args: event['args'] } : previous?.args === undefined ? {} : { args: previous.args }),
      ...(event['partialResult'] !== undefined ? { partial: event['partialResult'] } : previous?.partial === undefined ? {} : { partial: previous.partial }),
      ...(event['result'] !== undefined ? { result: event['result'] } : previous?.result === undefined ? {} : { result: previous.result }),
      running: type !== 'tool_execution_end',
      ...(type === 'tool_execution_end' ? { error: event['isError'] === true } : previous?.error === undefined ? {} : { error: previous.error }),
    }
  }
  return Object.fromEntries(Object.entries(tools).slice(-MAX_TOOLS))
}

function cappedMessages(messages: unknown[], message: unknown): unknown[] {
  return [...messages, message].slice(-MAX_MESSAGES)
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
  if (ids.length > MAX_TOOLS) delete tools[ids[0]!]
  return { ...state, tools }
}

function normalizeCapabilities(value: unknown): PiSubagentCapabilities {
  const object = record(value)
  const rawMethods = Array.isArray(object?.['methods']) ? object['methods'] : []
  const advertised = record(object?.['capabilities'])
  const methods = ['status', 'steer', 'interrupt', 'stop', 'resume']
    .filter((method) => rawMethods.includes(method) || advertised?.[method] === true)
  return {
    methods,
    status: methods.includes('status'), steer: methods.includes('steer'),
    interrupt: methods.includes('interrupt'), stop: methods.includes('stop'),
    resume: methods.includes('resume'), nonRecoveringSteer: advertised?.['nonRecoveringSteer'] === true,
  }
}

function normalizeActivity(value: unknown): PiSubagentActivity | undefined {
  const object = record(value)
  if (!object) return undefined
  const out: PiSubagentActivity = {}
  for (const key of ['state', 'currentTool'] as const) {
    const value = boundedText(object[key], 128)
    if (value) out[key] = value
  }
  for (const key of ['lastActivityAt', 'currentToolStartedAt', 'turnCount', 'toolCount'] as const) {
    const value = boundedNumber(object[key])
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function normalizeNode(value: unknown, depth = 0): PiSubagentNode | undefined {
  const object = record(value)
  const id = boundedText(object?.['id'], 256)
  const label = boundedText(object?.['label'], 160)
  const state = boundedText(object?.['state'], 32)
  if (!id || !label || !state) return undefined
  const node: PiSubagentNode = { id, label, state }
  const kind = boundedText(object?.['kind'], 32)
  if (kind) node.kind = kind
  const activity = normalizeActivity(object?.['activity'])
  if (activity) node.activity = activity
  for (const key of ['startedAt', 'updatedAt', 'endedAt'] as const) {
    const number = boundedNumber(object?.[key])
    if (number !== undefined) node[key] = number
  }
  if (depth < 3 && Array.isArray(object?.['children'])) {
    const children = object['children'].slice(0, MAX_SUBAGENT_CHILDREN)
      .map((child) => normalizeNode(child, depth + 1))
      .filter((child): child is PiSubagentNode => child !== undefined)
    if (children.length > 0) node.children = children
  }
  return node
}

function normalizeFleet(value: unknown): PiSubagentStatus['fleet'] {
  const object = record(value)
  const entries: PiSubagentFleetEntry[] = []
  const rawEntries = Array.isArray(object?.['entries']) ? object['entries'] : []
  for (const raw of rawEntries.slice(0, MAX_SUBAGENT_CHILDREN)) {
    const entry = record(raw)
    const agent = boundedText(entry?.['agent'], 96)
    const startedAt = boundedNumber(entry?.['startedAt'])
    if (!agent || startedAt === undefined) continue
    const tokensObject = record(entry?.['tokens'])
    const tokens: Record<string, number> = {}
    for (const key of ['input', 'output', 'total', 'window', 'windowPeak']) {
      const value = boundedNumber(tokensObject?.[key])
      if (value !== undefined) tokens[key] = value
    }
    const normalized: PiSubagentFleetEntry = { agent, startedAt, tokens }
    const role = boundedText(entry?.['role'], 96)
    const model = boundedText(entry?.['model'], 128)
    const effort = boundedText(entry?.['effort'], 128)
    const goal = boundedText(entry?.['goal'], 512)
    if (role) normalized.role = role
    if (model) normalized.model = model
    if (effort) normalized.effort = effort
    if (goal) normalized.goal = goal
    entries.push(normalized)
  }
  const capacity = record(object?.['topLevelAsyncCapacity'])
  return {
    entries,
    totalActive: boundedNumber(object?.['totalActive']) ?? entries.length,
    topLevelAsyncCapacity: { used: boundedNumber(capacity?.['used']) ?? 0, limit: boundedNumber(capacity?.['limit']) ?? 0 },
    omitted: boundedNumber(object?.['omitted']) ?? 0,
  }
}

/** Normalize the public, bounded subagent DTO before it reaches React. Fleet
 * entries are display-only; only `asyncRuns[].id` are valid controls. */
export function normalizeSubagentStatus(value: unknown): PiSubagentStatus {
  const object = record(value)
  const rawRuns = Array.isArray(object?.['asyncRuns']) ? object['asyncRuns'] : []
  const asyncRuns = rawRuns.slice(0, MAX_SUBAGENT_RUNS)
    .map((run) => normalizeNode(run))
    .filter((run): run is PiSubagentNode => run !== undefined)
  const capabilities = normalizeCapabilities(object?.['capabilities'])
  const omittedObject = record(object?.['asyncOmitted'])
  const reason = boundedText(object?.['reason'], 512)
  return {
    available: object?.['available'] === true,
    stale: object?.['stale'] === true,
    ...(reason ? { reason } : {}),
    capabilities,
    asyncRuns,
    fleet: normalizeFleet(object?.['fleet']),
    omitted: {
      runs: boundedNumber(omittedObject?.['runs']) ?? Math.max(0, rawRuns.length - asyncRuns.length),
      children: boundedNumber(omittedObject?.['children']) ?? 0,
      byteLimitExceeded: omittedObject?.['byteLimitExceeded'] === true,
    },
  }
}

function normalizeTranscript(value: unknown, requestId: string, runId: string, index?: number): PiSubagentTranscript {
  const object = record(value)
  const details = record(object?.['details']) ?? object
  const rawResults = Array.isArray(details?.['results']) ? details['results'] : []
  const results: PiSubagentTranscript['results'] = []
  for (const raw of rawResults.slice(0, MAX_SUBAGENT_CHILDREN)) {
    const child = record(raw)
    if (!child) continue
    const result: PiSubagentTranscript['results'][number] = {}
    const agent = boundedText(child['agent'], 96)
    const status = boundedText(child['status'], 32)
    const finalOutput = boundedText(child['finalOutput'])
    if (agent) result.agent = agent
    if (status) result.status = status
    if (finalOutput) result.finalOutput = finalOutput
    if (Array.isArray(child['messages'])) {
      const messages = child['messages'].slice(0, MAX_SUBAGENT_CHILDREN).flatMap((message): Array<{ text: string; role?: string; kind?: string; name?: string; isError?: boolean }> => {
        const item = record(message)
        const text = boundedText(item?.['text'], 2_048)
        if (!text) return []
        const normalized: { text: string; role?: string; kind?: string; name?: string; isError?: boolean } = { text }
        const role = boundedText(item?.['role'], 32)
        const kind = boundedText(item?.['kind'], 32)
        const name = boundedText(item?.['name'], 96)
        if (role) normalized.role = role
        if (kind) normalized.kind = kind
        if (name) normalized.name = name
        if (item?.['isError'] === true) normalized.isError = true
        return [normalized]
      })
      if (messages.length > 0) result.messages = messages
    }
    results.push(result)
  }
  return { requestId, runId, ...(index === undefined ? {} : { index }), text: boundedText(object?.['text']) ?? '', results }
}

export function normalizeSubagentReceipt(value: unknown, action: string, runId: string): PiSubagentReceipt {
  const object = record(value)
  const details = record(object?.['details'])
  const steering = record(details?.['steering'])
  const state = boundedText(object?.['state'], 32) ?? boundedText(steering?.['state'], 32)
  const receipt: PiSubagentReceipt = { action, runId }
  const childId = boundedText(object?.['childId'], 256)
  const message = boundedText(object?.['message'], 1_024)
  const text = boundedText(object?.['text'], 1_024)
  const deliveryStatus = boundedText(object?.['deliveryStatus'], 32) ?? boundedText(steering?.['deliveryStatus'], 32)
  const sourceRunId = boundedText(steering?.['sourceRunId'], 256)
  const replacementRunId = boundedText(steering?.['replacementRunId'], 256)
  if (state) receipt.state = state
  if (childId) receipt.childId = childId
  if (message) receipt.message = message
  if (text) receipt.text = text
  if (deliveryStatus === 'queued' || deliveryStatus === 'delivered') receipt.deliveryStatus = deliveryStatus
  if (sourceRunId) receipt.sourceRunId = sourceRunId
  if (replacementRunId) receipt.replacementRunId = replacementRunId
  return receipt
}

/** A stable, bounded timeline. Tool cards referenced by a message's
 * `toolCallId` stay at that message's position; unreferenced transient tools
 * appear once at the end rather than being rendered both inline and in a
 * second global list. */
export interface PiTimelineMessage {
  kind: 'message'
  key: string
  message: unknown
  tools: PiToolState[]
}
export interface PiTimelineTool {
  kind: 'tool'
  key: string
  tool: PiToolState
}
export type PiTimelineItem = PiTimelineMessage | PiTimelineTool

function messageToolIds(message: unknown): string[] {
  const object = record(message)
  const content = object?.['content']
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const item = record(part)
    if (!item || item['type'] !== 'toolCall') return []
    const id = typeof item['toolCallId'] === 'string' ? item['toolCallId']
      : typeof item['id'] === 'string' ? item['id'] : undefined
    return id ? [id] : []
  })
}

export function mergePiTimeline(messages: unknown[], tools: Record<string, PiToolState>, liveMessage?: unknown | null): PiTimelineItem[] {
  const used = new Set<string>()
  const out: PiTimelineItem[] = []
  messages.slice(-MAX_MESSAGES).forEach((message, index) => {
    const linked = messageToolIds(message).flatMap((id) => {
      const tool = tools[id]
      if (!tool) return []
      used.add(id)
      return [tool]
    })
    out.push({ kind: 'message', key: `message-${index}`, message, tools: linked })
  })
  if (liveMessage !== undefined && liveMessage !== null) {
    const linked = messageToolIds(liveMessage).flatMap((id) => {
      const tool = tools[id]
      if (!tool) return []
      used.add(id)
      return [tool]
    })
    out.push({ kind: 'message', key: 'live-message', message: liveMessage, tools: linked })
  }
  for (const [id, tool] of Object.entries(tools)) {
    if (!used.has(id)) out.push({ kind: 'tool', key: `tool-${id}`, tool })
  }
  return out
}

export function subagentCanControl(status: PiSubagentStatus, runId: string, action: keyof Pick<PiSubagentCapabilities, 'stop' | 'steer' | 'interrupt' | 'resume'>): boolean {
  return status.available && !status.stale
    && status.asyncRuns.some((run) => run.id === runId)
    && status.capabilities[action]
}

export function subagentCanLoadTranscript(status: PiSubagentStatus, runId: string): boolean {
  return status.available && !status.stale
    && status.asyncRuns.some((run) => run.id === runId)
    && status.capabilities.status
}

export function reducePiView(state: PiViewState, msg: ControlMsg): PiViewState {
  if (msg.kind === 'PiBridgeStatus') {
    return {
      ...state,
      available: msg.available,
      statusKnown: true,
      ...(!msg.available ? { lastSeq: 0, liveMessage: null, subagents: unavailableSubagents() } : {}),
    }
  }
  if (msg.kind !== 'PiEvent') return state
  const event = msg.event
  const kind = typeof event['kind'] === 'string' ? event['kind'] : ''
  // Snapshots are authoritative reconnect checkpoints and may come from a
  // restarted extension whose sequence restarted below the prior process.
  if (kind !== 'snapshot' && msg.seq <= state.lastSeq) return state
  const base = { ...state, lastSeq: msg.seq }

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
        tools: toolsFromEntries(event['entries']),
        model: record(event['model']),
        thinkingLevel: typeof event['thinkingLevel'] === 'string' ? event['thinkingLevel'] : 'off',
        contextUsage: record(event['contextUsage']),
        capabilities: {
          attachments: record(event['capabilities'])?.['attachments'] === true,
          promptReceipts: record(event['capabilities'])?.['promptReceipts'] === true,
        },
        error: null,
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
    case 'subagent_status': return { ...base, subagents: normalizeSubagentStatus(event) }
    case 'command_result': {
      const requestId = event['requestId']
      const command = event['command']
      if (typeof requestId !== 'string' || typeof command !== 'string') return base
      const result = {
        command,
        success: event['success'] === true,
        ...(typeof event['error'] === 'string' ? { error: event['error'] } : {}),
        ...(event['data'] === undefined ? {} : { data: event['data'] }),
      }
      const commandResults = { ...state.commandResults, [requestId]: result }
      const ids = Object.keys(commandResults)
      if (ids.length > 128) delete commandResults[ids[0]!]
      const next: PiViewState = {
        ...base,
        commandResults,
        ...(result.success ? {} : { error: result.error ?? `${command} failed` }),
      }
      if (command === 'SubagentStatus' && result.success) next.subagents = normalizeSubagentStatus(result.data)
      if (command === 'SubagentTranscript' && result.success) {
        const runId = record(result.data)?.['runId']
        if (typeof runId === 'string') next.transcripts = {
          ...state.transcripts,
          [requestId]: normalizeTranscript(result.data, requestId, runId, boundedNumber(record(result.data)?.['index'])),
        }
        const transcriptIds = Object.keys(next.transcripts)
        if (transcriptIds.length > MAX_SUBAGENT_TRANSCRIPTS) delete next.transcripts[transcriptIds[0]!]
      }
      if (command === 'SubagentControl' && result.success) {
        const receipt = record(result.data)
        const action = typeof receipt?.['action'] === 'string' ? receipt['action'] : 'control'
        const runId = typeof receipt?.['runId'] === 'string' ? receipt['runId'] : ''
        if (runId) next.receipts = { ...state.receipts, [requestId]: normalizeSubagentReceipt(result.data, action, runId) }
      }
      return next
    }
    case 'command_error':
    case 'bridge_error': return { ...base, error: typeof event['message'] === 'string' ? event['message'] : 'Pi bridge error' }
    default: return base
  }
}
