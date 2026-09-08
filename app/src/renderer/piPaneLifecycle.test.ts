import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiCommand } from '../shared/proto'
import { PiPane } from './PiPane'
import { piDraftKey, type PiDraftStorage } from './piDraft'
import { FakeEvent, withFakeDom, type FakeDomHandle, type FakeElement } from './mountedTestDom'

class TestPort {
  readonly posted: unknown[] = []
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null

  postMessage(message: unknown): void { this.posted.push(message) }
  start(): void {}
  close(): void { this.closed = true }
  emit(data: unknown): void { this.onmessage?.({ data }) }
}

function memoryStorage(): PiDraftStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function installAmber(dom: FakeDomHandle, port: TestPort, session = 'pi') {
  const windowValue = globalThis.window as unknown as {
    amber: { openPiPane: (name: string) => void; closePiPane: (name: string) => void }
    dispatchEvent: (event: unknown) => boolean
  }
  windowValue.amber = {
    openPiPane: (name) => {
      if (name !== session) return
      const event = Object.assign(new FakeEvent('message', { target: dom.container }), {
        data: { amberPanePort: true, session: name, mode: 'pi' },
        ports: [port],
      })
      windowValue.dispatchEvent?.(event as never)
    },
    closePiPane: () => {},
  }
}

function commandMessages(port: TestPort): PiCommand[] {
  return port.posted.flatMap((message) => {
    const command = (message as { command?: PiCommand }).command
    return command ? [command] : []
  })
}

function lastCommand(port: TestPort): PiCommand {
  const command = commandMessages(port).at(-1)
  if (!command) throw new Error('expected a Pi command')
  return command
}

let sequence = 0
function piEvent(port: TestPort, event: Record<string, unknown>): void {
  port.emit({ msg: { kind: 'PiEvent', name: 'pi', seq: ++sequence, event } })
}

function receipt(port: TestPort, command: PiCommand & { requestId?: string }, success = true, data?: unknown, error?: string): void {
  if (command.kind === 'Prompt' || command.kind === 'Abort' || command.kind === 'Snapshot' || command.kind === 'SetThinkingLevel') {
    throw new Error('receipt helper requires a correlated command')
  }
  if (!('requestId' in command) || typeof command.requestId !== 'string') throw new Error('correlated command has no request id')
  piEvent(port, {
    kind: 'command_result', requestId: command.requestId, command: command.kind, success,
    ...(data === undefined ? {} : { data }), ...(error === undefined ? {} : { error }),
  })
}

function submitForm(dom: FakeDomHandle): void {
  const form = dom.container.querySelector('form')
  if (!form) throw new Error('expected Pi composer form')
  form.dispatchEvent(new FakeEvent('submit', { target: form, bubbles: true }))
}

function testFile(read: () => Promise<ArrayBuffer>, name = 'notes.txt'): File {
  return {
    name, type: 'text/plain', size: 3, lastModified: 1,
    slice: () => ({ arrayBuffer: read }),
  } as unknown as File
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function renderPane(dom: FakeDomHandle, port: TestPort): Promise<{ root: { unmount: () => void }; storage: PiDraftStorage }> {
  const { createRoot } = await import('react-dom/client')
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  installAmber(dom, port)
  const root = createRoot(dom.container as unknown as Element)
  await act(async () => { root.render(createElement(PiPane, { session: 'pi', portEpoch: 1 })) })
  if (!port.onmessage) throw new Error('PiPane did not acquire its semantic port')
  return { root, storage }
}

afterEach(() => { sequence = 0; vi.useRealTimers() })

describe('mounted Pi pane transport and draft lifecycle', () => {
  it('flushes the newest edit when switching views immediately', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root, storage } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const textarea = dom.container.querySelector('[aria-label="Message Pi"]') as FakeElement
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
        setter?.call(textarea, 'latest edit')
        await act(async () => {
          textarea.dispatchEvent(new FakeEvent('input', { target: textarea, bubbles: true }))
          textarea.dispatchEvent(new FakeEvent('change', { target: textarea, bubbles: true }))
        })
        await act(async () => { root.unmount() })
        expect(storage.getItem(piDraftKey('pi'))).toBe('latest edit')
      } finally {
        if (!port.closed) await act(async () => { root.unmount() })
      }
    })
  })

  it('flushes the newest edit on pagehide before the debounce expires', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root, storage } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const textarea = dom.container.querySelector('[aria-label="Message Pi"]') as FakeElement
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
        setter?.call(textarea, 'pagehide edit')
        await act(async () => { textarea.dispatchEvent(new FakeEvent('input', { target: textarea, bubbles: true })) })
        await act(async () => {
          ;(globalThis.window as unknown as { dispatchEvent: (event: unknown) => boolean }).dispatchEvent(
            new FakeEvent('pagehide', { target: dom.container }),
          )
        })
        expect(storage.getItem(piDraftKey('pi'))).toBe('pagehide edit')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('invalidates an upload while File.read is pending after the semantic bridge is lost', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      let resolveRead!: (bytes: ArrayBuffer) => void
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const input = dom.container.querySelector('.pi-file-input') as FakeElement
        const file = testFile(() => new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve }))
        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        const send = dom.container.querySelector('.btn-accent') as FakeElement
        expect(send.disabled).toBe(false)
        await act(async () => { submitForm(dom) })
        const begin = lastCommand(port)
        expect(begin.kind).toBe('UploadBegin')
        await act(async () => { receipt(port, begin, true, { attachmentId: 'attachment-1' }); await settle() })

        await act(async () => {
          port.emit({ msg: { kind: 'PiBridgeStatus', name: 'pi', available: false } })
          resolveRead(new Uint8Array([97, 98, 99]).buffer)
          await settle()
        })
        expect(commandMessages(port).some((command) => command.kind === 'UploadChunk')).toBe(false)
        expect(commandMessages(port).some((command) => command.kind === 'PromptWithAttachments')).toBe(false)
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('keeps a prompt draft when its receipt is lost with the bridge', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const textarea = dom.container.querySelector('[aria-label="Message Pi"]') as FakeElement
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
        setter?.call(textarea, 'keep this prompt')
        await act(async () => { textarea.dispatchEvent(new FakeEvent('input', { target: textarea, bubbles: true })) })
        await act(async () => { submitForm(dom) })
        expect(lastCommand(port).kind).toBe('PromptWithAttachments')
        await act(async () => { port.emit({ msg: { kind: 'PiBridgeStatus', name: 'pi', available: false } }) })
        expect(textarea.value).toBe('keep this prompt')
        expect(dom.container.textContent).toContain('Bridge offline')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('rejects picker, drop, and paste additions while an upload is active', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      let resolveRead!: (bytes: ArrayBuffer) => void
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const input = dom.container.querySelector('.pi-file-input') as FakeElement
        const first = testFile(() => new Promise<ArrayBuffer>((resolve) => { resolveRead = resolve }), 'first.txt')
        const second = testFile(() => Promise.resolve(new Uint8Array([100, 101, 102]).buffer), 'second.txt')
        Object.defineProperty(input, 'files', { configurable: true, value: [first] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        await act(async () => { submitForm(dom) })
        const begin = lastCommand(port)
        expect(begin.kind).toBe('UploadBegin')
        await act(async () => { receipt(port, begin, true, { attachmentId: 'attachment-1' }); await settle() })

        Object.defineProperty(input, 'files', { configurable: true, value: [second] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        const form = dom.container.querySelector('form') as FakeElement
        const drop = Object.assign(new FakeEvent('drop', { target: form, bubbles: true }), { dataTransfer: { files: [second], types: [] } })
        await act(async () => { form.dispatchEvent(drop) })
        const textarea = dom.container.querySelector('[aria-label="Message Pi"]') as FakeElement
        const paste = Object.assign(new FakeEvent('paste', { target: textarea, bubbles: true }), { clipboardData: { files: [second], types: [] } })
        await act(async () => { textarea.dispatchEvent(paste) })

        expect(dom.container.querySelector('[aria-label="Remove first.txt"]') !== null).toBe(true)
        expect(dom.container.querySelector('[aria-label="Remove second.txt"]') !== null).toBe(false)

        resolveRead(new Uint8Array([97, 98, 99]).buffer)
        await act(async () => { await settle() })
        const chunk = lastCommand(port)
        expect(chunk.kind).toBe('UploadChunk')
        await act(async () => { receipt(port, chunk, true, { acknowledgedOffset: 3 }); await settle() })
        const finish = lastCommand(port)
        expect(finish.kind).toBe('UploadFinish')
        await act(async () => { receipt(port, finish, true, { attachmentId: 'attachment-1' }); await settle() })
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('prunes a removed completed attachment without deleting its server artifact', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const input = dom.container.querySelector('.pi-file-input') as FakeElement
        const file = testFile(() => Promise.resolve(new Uint8Array([97, 98, 99]).buffer))
        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        await act(async () => { submitForm(dom) })

        const begin = lastCommand(port)
        await act(async () => { receipt(port, begin, true, { attachmentId: 'attachment-1' }); await settle() })
        const chunk = lastCommand(port)
        await act(async () => { receipt(port, chunk, true, { acknowledgedOffset: 3 }); await settle() })
        const finish = lastCommand(port)
        await act(async () => { receipt(port, finish, true, { attachmentId: 'attachment-1' }); await settle() })
        const firstPrompt = lastCommand(port)
        expect(firstPrompt.kind).toBe('PromptWithAttachments')
        await act(async () => { receipt(port, firstPrompt, false, undefined, 'Pi model does not support image attachment notes.txt'); await settle() })

        const remove = dom.container.querySelector('[aria-label="Remove notes.txt"]') as FakeElement
        await act(async () => { remove.click() })
        expect(dom.container.querySelector('[aria-label="Remove notes.txt"]') !== null).toBe(false)
        expect(commandMessages(port).some((command) => command.kind === 'UploadCancel')).toBe(false)

        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        await act(async () => { submitForm(dom) })
        expect(lastCommand(port).kind).toBe('UploadBegin')
        expect(commandMessages(port).filter((command) => command.kind === 'UploadBegin')).toHaveLength(2)
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('resets pending operations and old receipts when the authoritative conversation changes', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const textarea = dom.container.querySelector('[aria-label="Message Pi"]') as FakeElement
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set
        setter?.call(textarea, 'unsent draft')
        await act(async () => { textarea.dispatchEvent(new FakeEvent('input', { target: textarea, bubbles: true })) })
        await act(async () => { submitForm(dom) })
        const oldPrompt = lastCommand(port)
        expect(oldPrompt.kind).toBe('PromptWithAttachments')

        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-b', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true },
            entries: [{ type: 'message', message: { role: 'user', content: 'new conversation' } }],
          })
        })
        expect(textarea.value).toBe('unsent draft')
        expect(dom.container.textContent).not.toContain('Sending…')
        await act(async () => { receipt(port, oldPrompt, true); await settle() })
        expect(textarea.value).toBe('unsent draft')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('reuses a completed attachment on explicit resend after a known model-capability failure', async () => {
    await withFakeDom(async (dom) => {
      const port = new TestPort()
      const { root } = await renderPane(dom, port)
      try {
        await act(async () => {
          piEvent(port, {
            kind: 'snapshot', sessionId: 'conversation-a', idle: true, pending: false,
            capabilities: { attachments: true, promptReceipts: true }, entries: [],
          })
        })
        const input = dom.container.querySelector('.pi-file-input') as FakeElement
        const file = testFile(() => Promise.resolve(new Uint8Array([97, 98, 99]).buffer))
        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        await act(async () => { input.dispatchEvent(new FakeEvent('change', { target: input, bubbles: true })) })
        await act(async () => { submitForm(dom) })

        const begin = lastCommand(port)
        await act(async () => { receipt(port, begin, true, { attachmentId: 'attachment-1' }); await settle() })
        const chunk = lastCommand(port)
        expect(chunk.kind).toBe('UploadChunk')
        await act(async () => { receipt(port, chunk, true, { acknowledgedOffset: 3 }); await settle() })
        const finish = lastCommand(port)
        expect(finish.kind).toBe('UploadFinish')
        await act(async () => { receipt(port, finish, true, { attachmentId: 'attachment-1' }); await settle() })
        const firstPrompt = lastCommand(port)
        expect(firstPrompt.kind).toBe('PromptWithAttachments')
        await act(async () => {
          receipt(port, firstPrompt, false, undefined, 'Pi model does not support image attachment notes.txt')
          await settle()
        })

        await act(async () => { submitForm(dom) })
        await settle()
        const secondPrompt = lastCommand(port)
        expect(secondPrompt.kind).toBe('PromptWithAttachments')
        await act(async () => {
          receipt(port, secondPrompt, false, undefined, 'Pi model does not support image attachment notes.txt')
          await settle()
        })
        await act(async () => { submitForm(dom) })
        await settle()
        const prompts = commandMessages(port).filter((command): command is Extract<PiCommand, { kind: 'PromptWithAttachments' }> => command.kind === 'PromptWithAttachments')
        const begins = commandMessages(port).filter((command) => command.kind === 'UploadBegin')
        expect(begins).toHaveLength(1)
        expect(prompts).toHaveLength(3)
        expect(prompts[1]!.attachments).toEqual(['attachment-1'])
        expect(prompts[2]!.attachments).toEqual(['attachment-1'])
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })
})
