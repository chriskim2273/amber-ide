import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ControlMsg, PiCommand, PiDelivery } from '../shared/proto'
import { initialPiViewState, reducePiView, type PiToolState } from './piModel'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function messageParts(message: unknown): Array<{ kind: 'text' | 'thinking' | 'tool'; value: string; label?: string }> {
  const m = asRecord(message)
  if (!m) return [{ kind: 'text', value: text(message) }]
  const content = m['content']
  if (typeof content === 'string') return [{ kind: 'text', value: content }]
  if (!Array.isArray(content)) return [{ kind: 'text', value: text(content ?? '') }]
  const parts: Array<{ kind: 'text' | 'thinking' | 'tool'; value: string; label?: string }> = []
  for (const part of content) {
    const p = asRecord(part)
    if (!p) continue
    if (p['type'] === 'text' && typeof p['text'] === 'string') parts.push({ kind: 'text', value: p['text'] })
    else if (p['type'] === 'thinking' && typeof p['thinking'] === 'string') parts.push({ kind: 'thinking', value: p['thinking'] })
    else if (p['type'] === 'toolCall') {
      parts.push({ kind: 'tool', label: typeof p['name'] === 'string' ? p['name'] : 'tool', value: text(p['arguments'] ?? p['args'] ?? {}) })
    }
  }
  return parts
}

function roleOf(message: unknown): string {
  const role = asRecord(message)?.['role']
  return typeof role === 'string' ? role : 'system'
}

/** Safe, deliberately small Markdown renderer. Text always remains React text
 * nodes: no raw HTML, no `dangerouslySetInnerHTML`, no scriptable links. */
function SafeMarkdown({ value }: { value: string }): JSX.Element {
  const blocks = useMemo(() => {
    const lines = value.split('\n')
    const result: Array<{ kind: string; value: string }> = []
    let code: string[] | null = null
    let paragraph: string[] = []
    const flush = (): void => {
      if (paragraph.length) result.push({ kind: 'p', value: paragraph.join('\n') })
      paragraph = []
    }
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (code) { result.push({ kind: 'code', value: code.join('\n') }); code = null }
        else { flush(); code = [] }
        continue
      }
      if (code) { code.push(line); continue }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      if (heading) { flush(); result.push({ kind: `h${heading[1]!.length}`, value: heading[2]! }); continue }
      if (/^\s*[-*]\s+/.test(line)) { flush(); result.push({ kind: 'li', value: line.replace(/^\s*[-*]\s+/, '') }); continue }
      if (line.trim() === '') { flush(); continue }
      paragraph.push(line)
    }
    if (code) result.push({ kind: 'code', value: code.join('\n') })
    flush()
    return result
  }, [value])
  return <div className="pi-markdown">
    {blocks.map((block, index) => {
      if (block.kind === 'code') return <pre key={index}><code>{block.value}</code></pre>
      if (block.kind === 'li') return <div className="pi-list-item" key={index}>• <span>{block.value}</span></div>
      if (block.kind === 'h1') return <h2 key={index}>{block.value}</h2>
      if (block.kind === 'h2') return <h3 key={index}>{block.value}</h3>
      if (block.kind === 'h3' || block.kind === 'h4') return <h4 key={index}>{block.value}</h4>
      return <p key={index}>{block.value}</p>
    })}
  </div>
}

function Message({ message, streaming = false }: { message: unknown; streaming?: boolean }): JSX.Element {
  const role = roleOf(message)
  const parts = messageParts(message)
  return <article className={`pi-message ${role}${streaming ? ' streaming' : ''}`}>
    <div className="pi-message-role">{role === 'assistant' ? 'Pi' : role === 'user' ? 'You' : role}</div>
    <div className="pi-message-body">
      {parts.map((part, index) => part.kind === 'thinking'
        ? <details className="pi-thinking" key={index}><summary>Thinking</summary><SafeMarkdown value={part.value} /></details>
        : part.kind === 'tool'
          ? <details className="pi-inline-tool" key={index}><summary>{part.label}</summary><pre>{part.value}</pre></details>
          : <SafeMarkdown value={part.value} key={index} />)}
      {streaming && <span className="pi-stream-caret" aria-hidden="true" />}
    </div>
  </article>
}

function ToolCard({ tool }: { tool: PiToolState }): JSX.Element {
  const value = tool.result ?? tool.partial ?? tool.args
  const rendered = text(value)
  return <details className={`pi-tool-card${tool.error ? ' error' : ''}`} open={tool.running}>
    <summary><span className={`pi-tool-dot${tool.running ? ' running' : ''}`} />{tool.name}<span>{tool.running ? 'running' : tool.error ? 'failed' : 'done'}</span></summary>
    {rendered && <pre>{rendered.slice(0, 20_000)}</pre>}
  </details>
}

export const PiPane = memo(function PiPane({ session, portEpoch }: { session: string; portEpoch: number }): JSX.Element {
  const [state, dispatch] = useReducer(reducePiView, initialPiViewState)
  const [draft, setDraft] = useState('')
  const [delivery, setDelivery] = useState<PiDelivery>('follow_up')
  const portRef = useRef<MessagePort | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  useEffect(() => {
    const onPort = (event: MessageEvent): void => {
      const data = event.data as { amberPanePort?: boolean; session?: string; mode?: string }
      if (!data?.amberPanePort || data.session !== session || data.mode !== 'pi' || !event.ports[0]) return
      window.removeEventListener('message', onPort)
      portRef.current?.close()
      const port = event.ports[0]
      portRef.current = port
      port.onmessage = (incoming) => {
        const msg = (incoming.data as { msg?: ControlMsg })?.msg
        if (msg) dispatch(msg)
      }
      port.start()
    }
    window.addEventListener('message', onPort)
    window.amber.openPiPane(session)
    return () => {
      window.removeEventListener('message', onPort)
      portRef.current?.close()
      portRef.current = null
      window.amber.closePiPane(session)
    }
  }, [session, portEpoch])

  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [state.messages, state.liveMessage, state.tools])

  const send = (command: PiCommand): void => portRef.current?.postMessage({ command })
  const submit = (): void => {
    const message = draft.trim()
    if (!message || !state.available) return
    send({ kind: 'Prompt', message, delivery: state.idle ? 'now' : delivery })
    setDraft('')
  }
  const modelName = typeof state.model?.['name'] === 'string'
    ? state.model['name']
    : typeof state.model?.['id'] === 'string' ? state.model['id'] : 'Pi'
  const percent = typeof state.contextUsage?.['percent'] === 'number' ? state.contextUsage['percent'] : null

  return <div className="pi-chat" tabIndex={0} aria-label="Pi graphical conversation">
    <div className="pi-chat-status" role="status">
      <span className={`pi-bridge-dot ${!state.statusKnown ? '' : state.available ? state.idle ? 'idle' : 'busy' : 'offline'}`} />
      <span>{!state.statusKnown ? 'Connecting' : state.available ? state.idle ? 'Ready' : 'Working' : 'Graphical bridge unavailable'}</span>
      <span className="pi-chat-model">{modelName}</span>
      {percent !== null && <span title="context used">{Math.round(percent)}%</span>}
      <label>Thinking
        <select value={state.thinkingLevel} disabled={!state.available}
          onChange={(e) => send({ kind: 'SetThinkingLevel', level: e.currentTarget.value })}>
          {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}
        </select>
      </label>
    </div>
    {state.awaitingUi && <div className="pi-dialog-notice" role="alert">
      Pi is waiting for {state.awaitingUi.title ?? `a ${state.awaitingUi.kind} response`} in the terminal view.
    </div>}
    {state.error && <div className="pi-chat-error" role="alert">{state.error}</div>}
    <div ref={transcriptRef} className="pi-transcript" role="log" aria-live="polite"
      onScroll={() => {
        const element = transcriptRef.current
        if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}>
      {state.messages.length === 0 && state.liveMessage === null &&
        <div className="pi-chat-empty"><strong>{state.statusKnown ? 'Pi graphical view' : 'Connecting to Pi'}</strong><span>The same supervised conversation, rendered semantically.</span></div>}
      {state.messages.map((message, index) => <Message key={index} message={message} />)}
      {Object.values(state.tools).map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      {state.liveMessage !== null && <Message message={state.liveMessage} streaming />}
      <div ref={endRef} />
    </div>
    <div className="pi-composer">
      <textarea value={draft} disabled={!state.available} placeholder={state.available ? 'Message Pi…' : 'Switch to Terminal or wait for the bridge…'}
        aria-label="Message Pi" rows={2}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }} />
      <div className="pi-composer-actions">
        {!state.idle && <select value={delivery} onChange={(e) => setDelivery(e.currentTarget.value as PiDelivery)} aria-label="Delivery mode">
          <option value="follow_up">Follow up</option><option value="steer">Steer now</option>
        </select>}
        {!state.idle && <button className="btn btn-ghost" onClick={() => send({ kind: 'Abort' })}>Stop</button>}
        <button className="btn btn-accent" disabled={!draft.trim() || !state.available} onClick={submit}>Send</button>
      </div>
    </div>
  </div>
})
