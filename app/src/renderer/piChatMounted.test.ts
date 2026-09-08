import { act, createElement, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PiCommand } from '../shared/proto'
import { PocketFocusHeader } from './PocketCommandCenter'
import { PiSubagents } from './PiSubagents'
import { normalizeSubagentStatus, type PiSubagentReceipt } from './piModel'
import { FakeEvent, withFakeDom } from './mountedTestDom'

const status = normalizeSubagentStatus({
  available: true,
  capabilities: { methods: ['resume'] },
  asyncRuns: [{ id: 'run-1', label: 'worker', state: 'stopped' }],
  fleet: { entries: [] },
})

describe('mounted Pi chat seams', () => {
  it('keeps a coarse-pointer Pocket Focus Pi toggle visible and dispatches both view changes', async () => {
    await withFakeDom(async (dom) => {
      const { createRoot } = await import('react-dom/client')
      const onPiView = vi.fn()
      const root = createRoot(dom.container as unknown as Element)
      try {
        expect((globalThis.window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia('(pointer: coarse)').matches).toBe(true)
        await act(async () => {
          root.render(createElement(PocketFocusHeader, {
            title: 'worker', machineName: 'phone', stateLabel: 'Pi ready', piView: 'terminal',
            onBack: () => {}, onActions: () => {}, onPiView,
          }))
        })
        const chat = dom.container.querySelector('[aria-label="Show Pi chat"]')
        expect(chat).not.toBeNull()
        expect(chat!.getBoundingClientRect().width).toBeGreaterThan(0)
        await act(async () => { chat!.click() })
        expect(onPiView).toHaveBeenCalledWith('gui')

        await act(async () => {
          root.render(createElement(PocketFocusHeader, {
            title: 'worker', machineName: 'phone', stateLabel: 'Pi ready', piView: 'gui',
            onBack: () => {}, onActions: () => {}, onPiView,
          }))
        })
        const terminal = dom.container.querySelector('[aria-label="Show Pi terminal"]')
        expect(terminal).not.toBeNull()
        await act(async () => { terminal!.click() })
        expect(onPiView).toHaveBeenLastCalledWith('terminal')
      } finally {
        await act(async () => { root.unmount() })
      }
    }, true)
  })

  it('sends a required Resume with message through the mounted control and clears only its correlated receipt', async () => {
    await withFakeDom(async (dom) => {
      const { createRoot } = await import('react-dom/client')
      const commands: Array<PiCommand & { requestId: string }> = []
      let deliver: ((requestId: string) => void) | undefined
      function Harness(): JSX.Element {
        const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
        const [receipts, setReceipts] = useState<Record<string, PiSubagentReceipt>>({})
        deliver = (requestId) => {
          setPending(new Set())
          setReceipts({ [requestId]: { action: 'resume', runId: 'run-1', state: 'resumed' } })
        }
        return createElement(PiSubagents, {
          status, transcripts: {}, receipts, pending,
          onCommand: (command) => {
            commands.push(command)
            setPending(new Set([command.requestId]))
          },
        })
      }

      const root = createRoot(dom.container as unknown as Element)
      try {
        await act(async () => { root.render(createElement(Harness)) })
        const toggle = dom.container.querySelector('.pi-subagents-toggle')
        expect(toggle).not.toBeNull()
        await act(async () => { toggle!.click() })
        const input = dom.container.querySelector('input')
        expect(input).not.toBeNull()
        const resumeBeforeMessage = dom.container.querySelectorAll('button').find((button) => button.textContent.includes('Resume with message'))
        expect(resumeBeforeMessage).not.toBeUndefined()
        expect(resumeBeforeMessage!.disabled).toBe(true)

        const nativeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input!), 'value')?.set
        nativeValueSetter?.call(input!, 'Continue from the stopped checkpoint')
        await act(async () => {
          input!.dispatchEvent(new FakeEvent('input', { target: input!, bubbles: true }))
          input!.dispatchEvent(new FakeEvent('change', { target: input!, bubbles: true }))
        })
        const resume = dom.container.querySelectorAll('button').find((button) => button.textContent.includes('Resume with message'))
        expect(resume!.disabled).toBe(false)
        await act(async () => { resume!.click() })
        expect(commands).toHaveLength(1)
        expect(commands[0]).toMatchObject({ kind: 'SubagentControl', action: 'resume', runId: 'run-1', message: 'Continue from the stopped checkpoint' })
        const requestId = commands[0]!.requestId
        expect(input!.value).toBe('Continue from the stopped checkpoint')

        await act(async () => { deliver?.(requestId) })
        expect(input!.value).toBe('')
      } finally {
        await act(async () => { root.unmount() })
      }
    })
  })
})
