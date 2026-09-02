import { describe, expect, it, vi } from 'vitest'
import { BrowserApprovalCoordinator, BrowserDialogCoordinator, approvalDigest, classifyInteraction, interactionTargetDigest, type ApprovalDigestInput } from './browserApproval'

const target = { role: 'button', name: 'Delete account', tag: 'button', type: 'submit', fingerprint: 'fp-1' }
const base: ApprovalDigestInput = { requestId: 'r1', controller: 'amber-1-1-0-pi', browserId: 'browser-0123456789abcdef0123456789abcdef', pageIncarnation: 'page-1', generation: 4, origin: 'https://example.test', action: 'click', targetFingerprint: 'fp-1', valueCategory: 'none', valueDigest: '', expiresAt: 6000 }

describe('browser consequential actions', () => {
  it('classifies sensitive, financial, destructive, communication, submit, and benign actions deterministically', () => {
    expect(classifyInteraction({ kind: 'fill', text: 'secret' }, { ...target, role: 'textbox', name: 'Password', type: 'password' })).toMatchObject({ consequential: true, category: 'credential', valueCategory: 'credential' })
    expect(classifyInteraction({ kind: 'click' }, { ...target, name: 'Pay $20 now' })).toMatchObject({ category: 'financial', canGrantOrigin: false })
    expect(classifyInteraction({ kind: 'click' }, target)).toMatchObject({ category: 'destructive' })
    expect(classifyInteraction({ kind: 'click' }, { ...target, name: 'Upload file', type: 'file' })).toMatchObject({ category: 'file-transfer', canGrantOrigin: false })
    expect(classifyInteraction({ kind: 'click' }, { ...target, name: 'Send message' })).toMatchObject({ category: 'communication' })
    expect(classifyInteraction({ kind: 'press', key: 'Enter' }, { ...target, name: 'Search', type: 'submit' })).toMatchObject({ category: 'form-submit' })
    expect(classifyInteraction({ kind: 'click' }, { ...target, name: 'Continue', type: 'button' })).toMatchObject({ category: 'confirmation', canGrantOrigin: true })
    expect(classifyInteraction({ kind: 'drag' }, { ...target, name: 'Item' }, { ...target, name: 'Delete permanently', fingerprint: 'fp-2' })).toMatchObject({ consequential: true, category: 'destructive' })
    expect(classifyInteraction({ kind: 'click' }, { ...target, role: 'button', type: 'button', name: 'Continue', formAction: '/messages/send', formMethod: 'post' })).toMatchObject({ consequential: true, category: 'communication' })
    expect(classifyInteraction({ kind: 'click' }, { ...target, role: 'button', type: 'button', name: 'Save', formAction: '/profile', formMethod: 'post' })).toMatchObject({ consequential: true, category: 'form-submit' })
    expect(classifyInteraction({ kind: 'fill', text: 'hello' }, { ...target, role: 'textbox', type: 'text', name: 'Display name', formAction: '/profile', formMethod: 'post' })).toMatchObject({ consequential: false, category: 'benign' })
    expect(interactionTargetDigest(target, { ...target, fingerprint: 'fp-2' })).not.toBe(interactionTargetDigest(target, { ...target, fingerprint: 'fp-3' }))
    expect(classifyInteraction({ kind: 'hover' }, target)).toEqual({ consequential: false, category: 'benign', valueCategory: 'none', canGrantOrigin: false, argumentSummary: '' })
  })

  it('binds every exact authority/action/target/value field without exposing values', () => {
    const digest = approvalDigest(base)
    for (const [key, value] of Object.entries(base)) {
      const changed = { ...base, [key]: typeof value === 'number' ? value + 1 : `${value}x` }
      expect(approvalDigest(changed)).not.toBe(digest)
    }
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).not.toContain('secret')
  })
})

describe('BrowserDialogCoordinator', () => {
  it('binds visible dialog decisions and fails closed while revealing a background surface', async () => {
    const events: unknown[] = [], reveal = vi.fn(), coordinator = new BrowserDialogCoordinator(() => 1000, () => false, (event) => events.push(event), 60_000, reveal)
    await expect(coordinator.request(base.browserId, 4, 'confirm', 'token=[REDACTED]')).resolves.toEqual({ accept: false })
    expect(reveal).toHaveBeenCalledWith(base.browserId); expect(events.at(-1)).toMatchObject({ type: 'dialog-request', headless: true, expiresAt: 61_000 })
    const visibleEvents: unknown[] = [], visible = new BrowserDialogCoordinator(() => 1000, () => true, (event) => visibleEvents.push(event), 60_000)
    const pending = visible.request(base.browserId, 5, 'prompt', 'Enter value')
    const request = visibleEvents.at(-1) as { dialogId: string; digest: string }
    expect(visible.resolve('browser-other', request.dialogId, request.digest, true, 'secret')).toBe(false)
    expect(visible.resolve(base.browserId, request.dialogId, request.digest, true, 'answer')).toBe(true)
    await expect(pending).resolves.toEqual({ accept: true, promptText: 'answer' })
  })

  it('rejects a pending dialog on revoke', async () => {
    const events: unknown[] = [], coordinator = new BrowserDialogCoordinator(() => 1000, () => true, (event) => events.push(event), 60_000)
    const pending = coordinator.request(base.browserId, 5, 'beforeunload', 'Leave?'); coordinator.clearBrowser(base.browserId)
    await expect(pending).resolves.toEqual({ accept: false }); expect(events.at(-1)).toMatchObject({ type: 'dialog-resolved', decision: 'revoked' })
  })
})

describe('BrowserApprovalCoordinator', () => {
  it('uses the 60 second contract by default', async () => {
    const events: unknown[] = [], coordinator = new BrowserApprovalCoordinator(() => 1000, () => true, (event) => events.push(event))
    const pending = coordinator.request({ ...base, category: 'destructive', canGrantOrigin: false, targetLabel: 'Delete', argumentSummary: '' }, new AbortController().signal)
    expect(events.at(-1)).toMatchObject({ expiresAt: 61_000 }); coordinator.clearBrowser(base.browserId); await expect(pending).rejects.toThrow('APPROVAL_DENIED')
  })

  it('fails closed headless and resolves only an exact live digest', async () => {
    let visible = false; const events: unknown[] = []; const reveal = vi.fn()
    const coordinator = new BrowserApprovalCoordinator(() => 1000, () => visible, (event) => events.push(event), 5000, reveal)
    await expect(coordinator.request({ ...base, category: 'destructive', canGrantOrigin: false, targetLabel: 'Delete account', argumentSummary: '' }, new AbortController().signal)).rejects.toThrow('APPROVAL_REQUIRED')
    expect(reveal).toHaveBeenCalledOnce()
    visible = true
    const pending = coordinator.request({ ...base, category: 'destructive', canGrantOrigin: false, targetLabel: 'Delete account', argumentSummary: '' }, new AbortController().signal)
    const request = events.at(-1) as { approvalId: string; digest: string }
    expect(coordinator.resolve('browser-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', request.approvalId, request.digest, 'approve-once')).toBe(false)
    expect(coordinator.resolve(base.browserId, request.approvalId, `${request.digest}bad`, 'approve-once')).toBe(false)
    visible = false; expect(coordinator.resolve(base.browserId, request.approvalId, request.digest, 'approve-once')).toBe(false)
    visible = true; expect(coordinator.resolve(base.browserId, request.approvalId, request.digest, 'approve-once')).toBe(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it('times out, aborts, clears on revoke, and allows only safe scoped grants', async () => {
    vi.useFakeTimers(); let now = 1000, visible = true; const events: unknown[] = [], reveal = vi.fn()
    const coordinator = new BrowserApprovalCoordinator(() => now, () => visible, (event) => events.push(event), 5000, reveal)
    const proposal = { ...base, category: 'confirmation' as const, canGrantOrigin: true, targetLabel: 'Continue', argumentSummary: '' }
    const first = coordinator.request(proposal, new AbortController().signal)
    const firstEvent = events.at(-1) as { approvalId: string; digest: string }
    expect(coordinator.resolve(base.browserId, firstEvent.approvalId, firstEvent.digest, 'allow-origin')).toBe(true)
    await first
    visible = false; await expect(coordinator.request(proposal, new AbortController().signal)).rejects.toThrow('APPROVAL_REQUIRED'); expect(reveal).toHaveBeenCalled()
    visible = true; await expect(coordinator.request(proposal, new AbortController().signal)).resolves.toBeUndefined()
    const destructive = coordinator.request({ ...proposal, requestId: 'r2', category: 'destructive', canGrantOrigin: false }, new AbortController().signal)
    const destructiveEvent = events.at(-1) as { approvalId: string; digest: string }
    expect(coordinator.resolve(base.browserId, destructiveEvent.approvalId, destructiveEvent.digest, 'allow-origin')).toBe(false)
    coordinator.clearBrowser(base.browserId)
    await expect(destructive).rejects.toThrow('APPROVAL_DENIED')
    const timeout = coordinator.request({ ...proposal, requestId: 'r3', origin: 'https://other.test' }, new AbortController().signal)
    const timeoutResult = expect(timeout).rejects.toThrow('APPROVAL_DENIED')
    now = 6001; await vi.advanceTimersByTimeAsync(5001)
    await timeoutResult
    vi.useRealTimers()
  })
})
