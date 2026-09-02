import { createHash, randomUUID } from 'node:crypto'
import type { BrowserInteraction } from './browserToolProtocol'

export type ApprovalCategory = 'credential' | 'financial' | 'destructive' | 'communication' | 'file-transfer' | 'form-submit' | 'confirmation' | 'benign'
export type ValueCategory = 'none' | 'text' | 'credential' | 'payment'
export interface InteractionTargetMetadata { role: string; name: string; tag: string; type: string; fingerprint: string; autocomplete?: string; formAction?: string; formMethod?: string }
export interface InteractionClassification { consequential: boolean; category: ApprovalCategory; valueCategory: ValueCategory; canGrantOrigin: boolean; argumentSummary: string }
export interface ApprovalDigestInput {
  requestId: string; controller: string; browserId: string; pageIncarnation: string; generation: number; origin: string
  action: string; targetFingerprint: string; valueCategory: ValueCategory; valueDigest: string; expiresAt?: number
}
export interface ApprovalProposal extends ApprovalDigestInput {
  category: Exclude<ApprovalCategory, 'benign'>; canGrantOrigin: boolean; targetLabel: string; argumentSummary: string
}
export type ApprovalDecision = 'approve-once' | 'reject' | 'allow-origin'
export interface BrowserApprovalEvent {
  type: 'approval-request' | 'approval-resolved'; browserId: string; approvalId: string; digest: string; controller?: string; origin?: string
  category?: string; targetLabel?: string; argumentSummary?: string; expiresAt?: number; canGrantOrigin?: boolean; decision?: ApprovalDecision | 'expired' | 'revoked'; headless?: boolean
}

const FINANCIAL = /\b(?:pay|purchase|buy|checkout|subscribe|transfer|bank|card|billing|donat|order)\b/i
const DESTRUCTIVE = /\b(?:delete|remove|disable|revoke|erase|destroy|terminate|cancel account)\b/i
const COMMUNICATION = /\b(?:send|publish|post|comment|reply|message|tweet|submit review)\b/i
const CONFIRMATION = /\b(?:continue|confirm|accept|proceed|allow)\b/i
const CREDENTIAL = /\b(?:password|passcode|credential|secret|token|api key|sign[ -]?in|log[ -]?in)\b/i
const PAYMENT_FIELD = /\b(?:card|cvv|cvc|expiry|routing|account number|payment)\b/i
const FILE_TRANSFER = /\b(?:upload|download|attach file|choose file)\b/i

function interactionText(operation: BrowserInteraction): string {
  if (operation.kind === 'fill' || operation.kind === 'type') return operation.text
  if (operation.kind === 'select') return operation.values.join('\u0000')
  if (operation.kind === 'press') return operation.key
  return ''
}
export function classifyInteraction(operation: Pick<BrowserInteraction, 'kind'> & Partial<BrowserInteraction>, target?: InteractionTargetMetadata, secondary?: InteractionTargetMetadata): InteractionClassification {
  const semantic = [target, secondary].map((item) => `${item?.role ?? ''} ${item?.name ?? ''} ${item?.tag ?? ''} ${item?.type ?? ''} ${item?.autocomplete ?? ''} ${item?.formAction ?? ''}`).join(' ')
  const raw = interactionText(operation as BrowserInteraction)
  const credential = target?.type === 'password' || CREDENTIAL.test(semantic) || /(?:current|new)-password/i.test(target?.autocomplete ?? '')
  const payment = PAYMENT_FIELD.test(semantic)
  const valueCategory: ValueCategory = raw ? (credential ? 'credential' : payment ? 'payment' : 'text') : 'none'
  const secretSummary = valueCategory === 'credential' || valueCategory === 'payment' ? `[${valueCategory} value omitted]` : raw.slice(0, 256)
  if (operation.kind === 'hover' || operation.kind === 'scroll') return { consequential: false, category: 'benign', valueCategory, canGrantOrigin: false, argumentSummary: '' }
  if (credential) return { consequential: true, category: 'credential', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (payment || FINANCIAL.test(semantic)) return { consequential: true, category: 'financial', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if ([target, secondary].some((item) => item?.type === 'file') || FILE_TRANSFER.test(semantic)) return { consequential: true, category: 'file-transfer', valueCategory, canGrantOrigin: false, argumentSummary: '' }
  if (DESTRUCTIVE.test(semantic)) return { consequential: true, category: 'destructive', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (COMMUNICATION.test(semantic)) return { consequential: true, category: 'communication', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  const activating = operation.kind === 'click' || operation.kind === 'doubleClick' || operation.kind === 'press' || operation.kind === 'drag'
  const submitLike = /\b(?:submit|save|apply|create|update|commit)\b/i.test(semantic) || [target, secondary].some((item) => item?.type === 'submit' || item?.role.toLocaleLowerCase() === 'form' || ((item?.tag === 'button' || item?.role.toLocaleLowerCase() === 'button') && item?.formMethod?.toLocaleLowerCase() === 'post'))
  if ((operation.kind === 'press' && operation.key === 'Enter') || (activating && submitLike)) return { consequential: true, category: 'form-submit', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if ((operation.kind === 'click' || operation.kind === 'doubleClick') && CONFIRMATION.test(semantic)) return { consequential: true, category: 'confirmation', valueCategory, canGrantOrigin: true, argumentSummary: '' }
  return { consequential: false, category: 'benign', valueCategory, canGrantOrigin: false, argumentSummary: '' }
}

export function interactionTargetDigest(primary: InteractionTargetMetadata, secondary?: InteractionTargetMetadata): string {
  return createHash('sha256').update(JSON.stringify([primary.fingerprint, secondary?.fingerprint ?? ''])).digest('hex')
}
export function interactionValueDigest(operation: BrowserInteraction): string {
  const value = interactionText(operation)
  return value ? createHash('sha256').update(value).digest('hex') : ''
}
export function approvalDigest(input: ApprovalDigestInput): string {
  return createHash('sha256').update(JSON.stringify({ requestId: input.requestId, controller: input.controller, browserId: input.browserId,
    pageIncarnation: input.pageIncarnation, generation: input.generation, origin: input.origin, action: input.action,
    targetFingerprint: input.targetFingerprint, valueCategory: input.valueCategory, valueDigest: input.valueDigest, expiresAt: input.expiresAt ?? 0 })).digest('hex')
}

interface Pending { proposal: ApprovalProposal; digest: string; expiresAt: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; signal: AbortSignal; abort: () => void }
export class BrowserApprovalCoordinator {
  private readonly pending = new Map<string, Pending>()
  private readonly grants = new Set<string>()
  constructor(private readonly now = Date.now, private readonly visible: (browserId: string) => boolean = () => false, private readonly onEvent: (event: BrowserApprovalEvent) => void = () => {}, private readonly ttlMs = 60_000, private readonly reveal: (browserId: string) => void = () => {}) {}
  private grantKey(proposal: ApprovalProposal): string { return `${proposal.controller}\u0000${proposal.browserId}\u0000${proposal.origin}\u0000${proposal.category}` }
  async request(proposal: ApprovalProposal, signal: AbortSignal): Promise<void> {
    const approvalId = randomUUID(), expiresAt = this.now() + this.ttlMs, digest = approvalDigest({ ...proposal, expiresAt })
    if (!this.visible(proposal.browserId)) {
      this.onEvent({ type: 'approval-request', browserId: proposal.browserId, approvalId, digest, controller: proposal.controller, origin: proposal.origin, category: proposal.category, targetLabel: proposal.targetLabel, argumentSummary: proposal.argumentSummary, expiresAt, canGrantOrigin: proposal.canGrantOrigin, headless: true })
      this.reveal(proposal.browserId); throw new Error('APPROVAL_REQUIRED')
    }
    if (signal.aborted) throw new Error('ACTION_CANCELLED')
    if (proposal.canGrantOrigin && this.grants.has(this.grantKey(proposal))) return
    if (this.pending.size >= 16) throw new Error('REQUEST_LIMIT')
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => this.finish(approvalId, 'revoked', new Error('ACTION_CANCELLED'))
      const timer = setTimeout(() => this.finish(approvalId, 'expired', new Error('APPROVAL_DENIED')), this.ttlMs); timer.unref()
      this.pending.set(approvalId, { proposal, digest, expiresAt, resolve, reject, timer, signal, abort })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted || !this.visible(proposal.browserId)) { this.finish(approvalId, 'revoked', new Error(signal.aborted ? 'ACTION_CANCELLED' : 'APPROVAL_DENIED')); return }
      this.onEvent({ type: 'approval-request', browserId: proposal.browserId, approvalId, digest, controller: proposal.controller, origin: proposal.origin, category: proposal.category, targetLabel: proposal.targetLabel, argumentSummary: proposal.argumentSummary, expiresAt, canGrantOrigin: proposal.canGrantOrigin })
    })
  }
  resolve(browserId: string, approvalId: string, digest: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(approvalId)
    if (!pending || pending.proposal.browserId !== browserId || pending.digest !== digest) return false
    if (this.now() > pending.expiresAt) { this.finish(approvalId, 'expired', new Error('APPROVAL_DENIED')); return false }
    if (pending.signal.aborted || !this.visible(browserId)) { this.finish(approvalId, 'revoked', new Error('APPROVAL_DENIED')); return false }
    if (decision === 'allow-origin' && !pending.proposal.canGrantOrigin) return false
    if (decision === 'allow-origin') this.grants.add(this.grantKey(pending.proposal))
    this.finish(approvalId, decision, decision === 'reject' ? new Error('APPROVAL_DENIED') : undefined)
    return true
  }
  private finish(approvalId: string, decision: ApprovalDecision | 'expired' | 'revoked', error?: Error): void {
    const pending = this.pending.get(approvalId); if (!pending) return
    this.pending.delete(approvalId); clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort)
    this.onEvent({ type: 'approval-resolved', browserId: pending.proposal.browserId, approvalId, digest: pending.digest, decision })
    if (error) pending.reject(error); else pending.resolve()
  }
  invalidateBrowser(browserId: string): void {
    for (const [id, pending] of this.pending) if (pending.proposal.browserId === browserId) this.finish(id, 'revoked', new Error('APPROVAL_DENIED'))
  }
  clearBrowser(browserId: string): void {
    this.invalidateBrowser(browserId)
    for (const key of this.grants) if (key.split('\u0000')[1] === browserId) this.grants.delete(key)
  }
}

export type BrowserDialogDecision = { accept: boolean; promptText?: string }
export interface BrowserDialogEvent {
  type: 'dialog-request' | 'dialog-resolved'; browserId: string; dialogId: string; digest: string; dialogType?: string; message?: string
  generation?: number; expiresAt?: number; decision?: 'accept' | 'reject' | 'expired' | 'revoked'; headless?: boolean
}
export interface BrowserDialogContext { browserId: string; pageIncarnation: string; generation: number; owner: string; signal: AbortSignal }
interface PendingDialog extends BrowserDialogContext { digest: string; expiresAt: number; resolve: (decision: BrowserDialogDecision) => void; timer: NodeJS.Timeout; abort: () => void }
export class BrowserDialogCoordinator {
  private readonly pending = new Map<string, PendingDialog>()
  constructor(private readonly now = Date.now, private readonly visible: (browserId: string) => boolean = () => false,
    private readonly currentIdentity: (browserId: string) => { pageIncarnation: string; generation: number } | null = () => null,
    private readonly onEvent: (event: BrowserDialogEvent) => void = () => {}, private readonly ttlMs = 60_000, private readonly reveal: (browserId: string) => void = () => {}) {}
  request(context: BrowserDialogContext, dialogType: string, message: string): Promise<BrowserDialogDecision> {
    const { browserId, pageIncarnation, generation, owner, signal } = context
    const dialogId = randomUUID(), expiresAt = this.now() + this.ttlMs
    const boundedType = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(dialogType) ? dialogType : 'confirm'
    const boundedMessage = message.slice(0, 1024)
    const digest = createHash('sha256').update(JSON.stringify({ browserId, pageIncarnation, generation, owner, dialogType: boundedType, messageDigest: createHash('sha256').update(boundedMessage).digest('hex'), expiresAt })).digest('hex')
    const event = { type: 'dialog-request' as const, browserId, dialogId, digest, dialogType: boundedType, message: boundedMessage, generation, expiresAt }
    const identity = this.currentIdentity(browserId)
    if (signal.aborted || !identity || identity.pageIncarnation !== pageIncarnation || identity.generation !== generation) return Promise.resolve({ accept: false })
    if (!this.visible(browserId)) { this.onEvent({ ...event, headless: true }); this.reveal(browserId); return Promise.resolve({ accept: false }) }
    if (this.pending.size >= 16) return Promise.resolve({ accept: false })
    return new Promise((resolve) => {
      const abort = (): void => this.finish(dialogId, 'revoked', { accept: false })
      const timer = setTimeout(() => this.finish(dialogId, 'expired', { accept: false }), this.ttlMs); timer.unref()
      this.pending.set(dialogId, { ...context, digest, expiresAt, resolve, timer, abort }); signal.addEventListener('abort', abort, { once: true })
      const live = this.currentIdentity(browserId)
      if (signal.aborted || !this.visible(browserId) || !live || live.pageIncarnation !== pageIncarnation || live.generation !== generation) { this.finish(dialogId, 'revoked', { accept: false }); return }
      this.onEvent(event)
    })
  }
  resolve(browserId: string, dialogId: string, digest: string, accept: boolean, promptText?: string): boolean {
    const pending = this.pending.get(dialogId)
    if (!pending || pending.browserId !== browserId || pending.digest !== digest) return false
    if (this.now() > pending.expiresAt) { this.finish(dialogId, 'expired', { accept: false }); return false }
    const identity = this.currentIdentity(browserId)
    if (!this.visible(browserId) || pending.signal.aborted || !identity || identity.pageIncarnation !== pending.pageIncarnation || identity.generation !== pending.generation) {
      this.finish(dialogId, 'revoked', { accept: false }); return false
    }
    this.finish(dialogId, accept ? 'accept' : 'reject', { accept, ...(accept && promptText !== undefined ? { promptText: promptText.slice(0, 4096) } : {}) }); return true
  }
  invalidateIdentity(browserId: string, pageIncarnation: string, generation: number): void { for (const [id, pending] of this.pending) if (pending.browserId === browserId && (pending.pageIncarnation !== pageIncarnation || pending.generation !== generation)) this.finish(id, 'revoked', { accept: false }) }
  clearBrowser(browserId: string): void { for (const [id, pending] of this.pending) if (pending.browserId === browserId) this.finish(id, 'revoked', { accept: false }) }
  private finish(dialogId: string, decision: 'accept' | 'reject' | 'expired' | 'revoked', value: BrowserDialogDecision): void {
    const pending = this.pending.get(dialogId); if (!pending) return
    this.pending.delete(dialogId); clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort); this.onEvent({ type: 'dialog-resolved', browserId: pending.browserId, dialogId, digest: pending.digest, decision }); pending.resolve(value)
  }
}
