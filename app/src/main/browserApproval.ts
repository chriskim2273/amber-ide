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
export function classifyInteraction(operation: Pick<BrowserInteraction, 'kind'> & Partial<BrowserInteraction>, target?: InteractionTargetMetadata): InteractionClassification {
  const semantic = `${target?.role ?? ''} ${target?.name ?? ''} ${target?.tag ?? ''} ${target?.type ?? ''} ${target?.autocomplete ?? ''}`
  const raw = interactionText(operation as BrowserInteraction)
  const credential = target?.type === 'password' || CREDENTIAL.test(semantic) || /(?:current|new)-password/i.test(target?.autocomplete ?? '')
  const payment = PAYMENT_FIELD.test(semantic)
  const valueCategory: ValueCategory = raw ? (credential ? 'credential' : payment ? 'payment' : 'text') : 'none'
  const secretSummary = valueCategory === 'credential' || valueCategory === 'payment' ? `[${valueCategory} value omitted]` : raw.slice(0, 256)
  if (operation.kind === 'hover' || operation.kind === 'scroll' || operation.kind === 'drag') return { consequential: false, category: 'benign', valueCategory, canGrantOrigin: false, argumentSummary: '' }
  if (credential) return { consequential: true, category: 'credential', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (payment || FINANCIAL.test(semantic)) return { consequential: true, category: 'financial', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (target?.type === 'file' || FILE_TRANSFER.test(semantic)) return { consequential: true, category: 'file-transfer', valueCategory, canGrantOrigin: false, argumentSummary: '' }
  if (DESTRUCTIVE.test(semantic)) return { consequential: true, category: 'destructive', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (COMMUNICATION.test(semantic)) return { consequential: true, category: 'communication', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if (operation.kind === 'press' && operation.key === 'Enter' || target?.type === 'submit' || target?.role === 'form') return { consequential: true, category: 'form-submit', valueCategory, canGrantOrigin: false, argumentSummary: secretSummary }
  if ((operation.kind === 'click' || operation.kind === 'doubleClick') && CONFIRMATION.test(semantic)) return { consequential: true, category: 'confirmation', valueCategory, canGrantOrigin: true, argumentSummary: '' }
  return { consequential: false, category: 'benign', valueCategory, canGrantOrigin: false, argumentSummary: '' }
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
  constructor(private readonly now = Date.now, private readonly visible = () => false, private readonly onEvent: (event: BrowserApprovalEvent) => void = () => {}, private readonly ttlMs = 30_000, private readonly reveal = () => {}) {}
  private grantKey(proposal: ApprovalProposal): string { return `${proposal.controller}\u0000${proposal.browserId}\u0000${proposal.origin}\u0000${proposal.category}` }
  async request(proposal: ApprovalProposal, signal: AbortSignal): Promise<void> {
    if (proposal.canGrantOrigin && this.grants.has(this.grantKey(proposal))) return
    const approvalId = randomUUID(), expiresAt = this.now() + this.ttlMs, digest = approvalDigest({ ...proposal, expiresAt })
    if (!this.visible()) {
      this.onEvent({ type: 'approval-request', browserId: proposal.browserId, approvalId, digest, controller: proposal.controller, origin: proposal.origin, category: proposal.category, targetLabel: proposal.targetLabel, argumentSummary: proposal.argumentSummary, expiresAt, canGrantOrigin: proposal.canGrantOrigin, headless: true })
      this.reveal(); throw new Error('APPROVAL_REQUIRED')
    }
    if (signal.aborted) throw new Error('ACTION_CANCELLED')
    if (this.pending.size >= 16) throw new Error('REQUEST_LIMIT')
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => this.finish(approvalId, 'revoked', new Error('ACTION_CANCELLED'))
      const timer = setTimeout(() => this.finish(approvalId, 'expired', new Error('APPROVAL_DENIED')), this.ttlMs); timer.unref()
      this.pending.set(approvalId, { proposal, digest, expiresAt, resolve, reject, timer, signal, abort })
      signal.addEventListener('abort', abort, { once: true })
      this.onEvent({ type: 'approval-request', browserId: proposal.browserId, approvalId, digest, controller: proposal.controller, origin: proposal.origin, category: proposal.category, targetLabel: proposal.targetLabel, argumentSummary: proposal.argumentSummary, expiresAt, canGrantOrigin: proposal.canGrantOrigin })
    })
  }
  resolve(browserId: string, approvalId: string, digest: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(approvalId)
    if (!pending || pending.proposal.browserId !== browserId || pending.digest !== digest || this.now() > pending.expiresAt) return false
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
