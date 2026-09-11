import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PromptEnhancer } from './PromptEnhancer'
import { readPiDraft, type PiDraftStorage } from './piDraft'
import { FakeEvent, withFakeDom, type FakeDomHandle, type FakeElement } from './mountedTestDom'

function memoryStorage(): PiDraftStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function installAmber(
  routerEnhance: (prompt: string) => Promise<{ ok: boolean; text?: string; error?: string }>,
  clipboardWrite: (text: string) => void,
): void {
  const windowValue = globalThis.window as unknown as { amber: unknown }
  windowValue.amber = { routerEnhance, clipboardWrite }
}

function setText(element: FakeElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
  if (!setter) throw new Error('fake textarea has no value setter')
  setter.call(element, value)
}

async function typeInto(dom: FakeDomHandle, ariaLabel: string, value: string): Promise<FakeElement> {
  const element = dom.container.querySelector(`[aria-label="${ariaLabel}"]`) as FakeElement
  if (!element) throw new Error(`expected [aria-label="${ariaLabel}"]`)
  setText(element, value)
  await act(async () => {
    element.dispatchEvent(new FakeEvent('input', { target: element, bubbles: true }))
  })
  return element
}

function clickButton(dom: FakeDomHandle, text: string): FakeElement {
  const button = dom.container.querySelectorAll('button').find((candidate) => candidate.textContent === text)
  if (!button) throw new Error(`button "${text}" not found`)
  return button
}

const TARGETS = [
  { name: 'pi-1', label: '#1 pi-1' },
  { name: 'pi-2', label: '#2 pi-2' },
]

async function renderEnhancer(
  dom: FakeDomHandle,
  props: { targets?: { name: string; label: string }[]; initial?: string } = {},
): Promise<{ root: { unmount: () => void } }> {
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.container as unknown as Element)
  await act(async () => {
    root.render(createElement(PromptEnhancer, {
      targets: props.targets ?? TARGETS,
      initial: props.initial ?? '',
      onClose: () => {},
    }))
  })
  return { root }
}

describe('mounted prompt enhancer', () => {
  it('enhances, then iterates on the edited output', async () => {
    await withFakeDom(async (dom) => {
      const routerEnhance = vi.fn(async (prompt: string) => ({ ok: true, text: `RW:${prompt}` }))
      installAmber(routerEnhance, () => {})
      const { root } = await renderEnhancer(dom)
      try {
        await typeInto(dom, 'Prompt to enhance', 'make it short')
        await act(async () => { clickButton(dom, 'Enhance').click() })
        expect(routerEnhance).toHaveBeenCalledWith('make it short')
        const output = dom.container.querySelector('[aria-label="Enhanced prompt"]') as FakeElement
        expect(output.value).toBe('RW:make it short')

        // Edit the rewrite, then iterate: the edited text is the next input.
        await typeInto(dom, 'Enhanced prompt', 'RW:make it short, politely')
        await act(async () => { clickButton(dom, 'Enhance again').click() })
        expect(routerEnhance).toHaveBeenLastCalledWith('RW:make it short, politely')
        expect(output.value).toBe('RW:RW:make it short, politely')
        expect(dom.container.textContent).toContain('Iteration 2.')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('surfaces a router failure without losing either text', async () => {
    await withFakeDom(async (dom) => {
      installAmber(async () => ({ ok: false, error: 'every credential in the chain is dead' }), () => {})
      const { root } = await renderEnhancer(dom)
      try {
        await typeInto(dom, 'Prompt to enhance', 'do the thing')
        await act(async () => { clickButton(dom, 'Enhance').click() })
        const alert = dom.container.querySelector('[role="alert"]')
        expect(alert?.textContent).toContain('every credential in the chain is dead')
        expect((dom.container.querySelector('[aria-label="Prompt to enhance"]') as FakeElement).value)
          .toBe('do the thing')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('copies the rewrite and inserts it into the chosen Pi draft', async () => {
    await withFakeDom(async (dom) => {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() })
      const clipboardWrite = vi.fn()
      installAmber(async (prompt: string) => ({ ok: true, text: `RW:${prompt}` }), clipboardWrite)
      const { root } = await renderEnhancer(dom)
      try {
        await typeInto(dom, 'Prompt to enhance', 'summarise this')
        await act(async () => { clickButton(dom, 'Enhance').click() })

        await act(async () => { clickButton(dom, 'Copy').click() })
        expect(clipboardWrite).toHaveBeenCalledWith('RW:summarise this')
        expect(dom.container.textContent).toContain('copied to clipboard')

        // The broadcast half of insert is covered in piDraft.test.ts (the
        // fake DOM cannot dispatch a real CustomEvent); here the durable
        // write plus the confirmation prove the dialog did its part.
        await act(async () => { clickButton(dom, 'Insert into Pi draft').click() })
        expect(readPiDraft('pi-1')).toBe('RW:summarise this')
        expect(dom.container.textContent).toContain('inserted into pi-1')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })

  it('offers copy-only when no Pi session is live', async () => {
    await withFakeDom(async (dom) => {
      installAmber(async (prompt: string) => ({ ok: true, text: `RW:${prompt}` }), () => {})
      const { root } = await renderEnhancer(dom, { targets: [] })
      try {
        expect(dom.container.querySelector('select')).toBeNull()
        expect(dom.container.textContent).toContain('Copy works anywhere.')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })
})
