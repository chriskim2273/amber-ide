import { useMemo, useState, type RefObject } from 'react'
import { mergePiTimeline, type PiToolState } from './piModel'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

export type MarkdownBlock =
  | { kind: 'paragraph' | 'heading' | 'quote' | 'list'; value: string; level?: number }
  | { kind: 'code'; value: string; language?: string }

/** Parse only the presentation subset used by Pi. HTML is kept as text because
 * this function never returns markup from untrusted content. */
export function markdownBlocks(value: string): MarkdownBlock[] {
  const result: MarkdownBlock[] = []
  let paragraph: string[] = []
  let code: string[] | null = null
  let language: string | undefined
  const flush = (): void => {
    if (paragraph.length > 0) result.push({ kind: 'paragraph', value: paragraph.join('\n') })
    paragraph = []
  }
  for (const line of value.split('\n')) {
    const fence = /^\s*```\s*([^`]*)$/.exec(line)
    if (fence) {
      if (code) {
        result.push({ kind: 'code', value: code.join('\n'), ...(language ? { language } : {}) })
        code = null
        language = undefined
      } else {
        flush()
        code = []
        language = fence[1]!.trim() || undefined
      }
      continue
    }
    if (code) { code.push(line); continue }
    if (line.trim() === '') { flush(); continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { flush(); result.push({ kind: 'heading', value: heading[2]!, level: heading[1]!.length }); continue }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) { flush(); result.push({ kind: 'quote', value: quote[1]! }); continue }
    const list = /^\s*(?:[-*+] |\d+[.)] )(.*)$/.exec(line)
    if (list) { flush(); result.push({ kind: 'list', value: list[1]! }); continue }
    paragraph.push(line)
  }
  if (code) result.push({ kind: 'code', value: code.join('\n'), ...(language ? { language } : {}) })
  flush()
  return result
}

export function safeMarkdownHref(value: string): string | null {
  try {
    const url = new URL(value, 'https://amber.invalid')
    // Relative links are intentionally not made clickable: a semantic chat
    // pane must not navigate the host app or fetch local files.
    return (url.protocol === 'http:' || url.protocol === 'https:') && /^[a-z][a-z\d+.-]*:/i.test(value)
      ? value : null
  } catch {
    return null
  }
}

function inlineTokens(value: string): Array<{ kind: 'text' | 'code' | 'strong' | 'em' | 'link'; value: string; href?: string }> {
  const out: Array<{ kind: 'text' | 'code' | 'strong' | 'em' | 'link'; value: string; href?: string }> = []
  // Deliberately small lexer. Rendering unknown syntax as text is safer than
  // trying to interpret arbitrary HTML or URL schemes.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\n]+)\))/g
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? cursor
    if (start > cursor) out.push({ kind: 'text', value: value.slice(cursor, start) })
    const token = match[0]
    if (token.startsWith('`')) out.push({ kind: 'code', value: token.slice(1, -1) })
    else if (token.startsWith('**') || token.startsWith('__')) out.push({ kind: 'strong', value: token.slice(2, -2) })
    else if (token.startsWith('*') || token.startsWith('_')) out.push({ kind: 'em', value: token.slice(1, -1) })
    else {
      const label = match[3] ?? ''
      const href = safeMarkdownHref(match[4] ?? '')
      out.push(href ? { kind: 'link', value: label, href } : { kind: 'text', value: label })
    }
    cursor = start + token.length
  }
  if (cursor < value.length) out.push({ kind: 'text', value: value.slice(cursor) })
  return out
}

function SafeInline({ value }: { value: string }): JSX.Element {
  return <>{inlineTokens(value).map((token, index) => {
    if (token.kind === 'code') return <code key={index}>{token.value}</code>
    if (token.kind === 'strong') return <strong key={index}>{token.value}</strong>
    if (token.kind === 'em') return <em key={index}>{token.value}</em>
    if (token.kind === 'link' && token.href) return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{token.value}</a>
    return <span key={index}>{token.value}</span>
  })}</>
}

/** React-safe Markdown: no raw HTML, no remote images, and only explicit
 * http(s) links. Exported for focused pure tests as well as the transcript. */
export function SafeMarkdown({ value }: { value: string }): JSX.Element {
  return <div className="pi-markdown">
    {markdownBlocks(value).map((block, index) => {
      if (block.kind === 'code') return <pre key={index} data-language={block.language}><code>{block.value}</code><CopyButton value={block.value} label="Copy code" /></pre>
      if (block.kind === 'heading') {
        const Heading = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4'
        return <Heading key={index}><SafeInline value={block.value} /></Heading>
      }
      if (block.kind === 'quote') return <blockquote key={index}><SafeInline value={block.value} /></blockquote>
      if (block.kind === 'list') return <div className="pi-list-item" key={index}>• <span><SafeInline value={block.value} /></span></div>
      return <p key={index}><SafeInline value={block.value} /></p>
    })}
  </div>
}

function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return <button type="button" className="pi-copy" aria-label={label} title={label} onClick={() => {
    const promise = navigator.clipboard?.writeText(value)
    if (promise) void promise.then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }}>{copied ? 'Copied' : 'Copy'}</button>
}

function roleOf(message: unknown): string {
  const role = asRecord(message)?.['role']
  return typeof role === 'string' ? role : 'system'
}

export interface PiMessagePart {
  kind: 'text' | 'thinking' | 'tool' | 'tool-result' | 'unknown'
  value: string
  label?: string
  toolCallId?: string
}

export function messageParts(message: unknown): PiMessagePart[] {
  const m = asRecord(message)
  if (!m) return [{ kind: 'text', value: displayText(message) }]
  const content = m['content']
  if (typeof content === 'string') return [{ kind: 'text', value: content }]
  if (!Array.isArray(content)) return [{ kind: 'text', value: displayText(content ?? '') }]
  const parts: PiMessagePart[] = []
  for (const raw of content) {
    const part = asRecord(raw)
    if (!part) { parts.push({ kind: 'unknown', value: displayText(raw), label: 'Unknown content' }); continue }
    if (part['type'] === 'text' && typeof part['text'] === 'string') parts.push({ kind: 'text', value: part['text'] })
    else if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') parts.push({ kind: 'thinking', value: part['thinking'] })
    else if (part['type'] === 'toolResult') {
      const id = typeof part['toolCallId'] === 'string' ? part['toolCallId'] : typeof part['id'] === 'string' ? part['id'] : undefined
      parts.push({ kind: 'tool-result', label: 'Tool result', value: displayText(part['result'] ?? part['content'] ?? ''), ...(id ? { toolCallId: id } : {}) })
    } else if (part['type'] === 'toolCall') {
      const id = typeof part['toolCallId'] === 'string' ? part['toolCallId'] : typeof part['id'] === 'string' ? part['id'] : undefined
      parts.push({ kind: 'tool', label: typeof part['name'] === 'string' ? part['name'] : 'tool', value: displayText(part['arguments'] ?? part['args'] ?? {}), ...(id ? { toolCallId: id } : {}) })
    } else if (part['type'] === 'image') {
      parts.push({ kind: 'unknown', label: 'Image', value: '[image attached]' })
    } else {
      parts.push({ kind: 'unknown', label: typeof part['type'] === 'string' ? part['type'] : 'Unknown content', value: displayText(part['text'] ?? part) })
    }
  }
  return parts.length > 0 ? parts : [{ kind: 'text', value: '' }]
}

function ToolCard({ tool }: { tool: PiToolState }): JSX.Element {
  const value = tool.result ?? tool.partial ?? tool.args
  const rendered = value === undefined ? '' : displayText(value)
  return <details className={`pi-tool-card${tool.error ? ' error' : ''}`} open={tool.running}>
    <summary><span className={`pi-tool-dot${tool.running ? ' running' : ''}`} />{tool.name}<span>{tool.running ? 'running' : tool.error ? 'failed' : 'done'}</span></summary>
    {rendered && <pre>{rendered.slice(0, 20_000)}<CopyButton value={rendered} label={`Copy ${tool.name} result`} /></pre>}
  </details>
}

function Message({ message, tools, streaming = false }: { message: unknown; tools: PiToolState[]; streaming?: boolean }): JSX.Element {
  const role = roleOf(message)
  const parts = messageParts(message)
  const byId = new Map(tools.map((tool) => [tool.id, tool]))
  return <article className={`pi-message ${role}${streaming ? ' streaming' : ''}`}>
    <div className="pi-message-role">{role === 'assistant' ? 'Pi' : role === 'user' ? 'You' : role}</div>
    <div className="pi-message-body">
      {parts.map((part, index) => {
        if (part.kind === 'thinking') return <details className="pi-thinking" key={index}><summary>Thinking</summary><SafeMarkdown value={part.value} /></details>
        if (part.kind === 'tool' || part.kind === 'tool-result') {
          const tool = part.toolCallId ? byId.get(part.toolCallId) : undefined
          if (part.kind === 'tool-result' && tool) return <span key={index} className="pi-tool-result-marker" aria-label="tool result" />
          return <div key={index} className="pi-inline-tool-wrap"><details className="pi-inline-tool"><summary>{part.label}</summary><pre>{part.value}</pre></details>{tool && <ToolCard tool={tool} />}</div>
        }
        if (part.kind === 'unknown') return <details className="pi-unknown-content" key={index}><summary>{part.label ?? 'Unknown content'}</summary><pre>{part.value}</pre></details>
        return <SafeMarkdown value={part.value} key={index} />
      })}
      {streaming && <span className="pi-stream-caret" aria-hidden="true" />}
      <CopyButton value={parts.map((part) => part.value).join('\n')} label="Copy message" />
    </div>
  </article>
}

export interface PiTranscriptProps {
  messages: unknown[]
  liveMessage: unknown | null
  tools: Record<string, PiToolState>
  transcriptRef?: RefObject<HTMLDivElement>
  endRef?: RefObject<HTMLDivElement>
  follow: boolean
  onFollowChange: (follow: boolean) => void
}

export function PiTranscript({ messages, liveMessage, tools, transcriptRef, endRef, follow, onFollowChange }: PiTranscriptProps): JSX.Element {
  const timeline = useMemo(() => mergePiTimeline(messages, tools, liveMessage), [messages, tools, liveMessage])
  // The transcript is a large streaming region. Screen readers should not
  // announce every token; coarse bridge/status messages use role=status/alert.
  return <div ref={transcriptRef} className="pi-transcript" role="log" aria-live="off"
    onScroll={() => {
      const element = transcriptRef?.current
      if (element) onFollowChange(element.scrollHeight - element.scrollTop - element.clientHeight < 80)
    }}>
    {timeline.length === 0 && <div className="pi-chat-empty"><strong>Pi graphical view</strong><span>The same supervised conversation, rendered semantically.</span></div>}
    {timeline.map((item) => item.kind === 'message'
      ? <Message key={item.key} message={item.message} tools={item.tools} streaming={item.key === 'live-message'} />
      : <ToolCard key={item.key} tool={item.tool} />)}
    {!follow && timeline.length > 0 && <button className="pi-jump-latest" type="button" onClick={() => endRef?.current?.scrollIntoView({ block: 'end' })}>Jump to latest</button>}
    <div ref={endRef} />
  </div>
}
