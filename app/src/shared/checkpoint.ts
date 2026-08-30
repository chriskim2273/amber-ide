import { parseWorkspaceFile, type WorkspaceDoc } from './workspaceFile'

export const CHECKPOINT_ID = /^[a-z0-9-]{8,64}$/
export const CHECKPOINT_FILE_MAX = 128 * 1024 * 1024
export interface CheckpointMeta {
  id: string
  name: string
  createdAt: number
  scope: 'one' | 'all'
  automatic: boolean
}
export interface CheckpointDoc extends WorkspaceDoc { checkpoint: CheckpointMeta }
export interface CheckpointSummary extends CheckpointMeta { bytes: number }

export function parseCheckpoint(text: string): CheckpointDoc {
  if (new TextEncoder().encode(text).length > CHECKPOINT_FILE_MAX) throw new Error('checkpoint exceeds 128 MiB')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('invalid checkpoint JSON') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid checkpoint')
  const meta = (raw as Record<string, unknown>)['checkpoint']
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('missing checkpoint metadata')
  const m = meta as Record<string, unknown>
  if (typeof m['id'] !== 'string' || !CHECKPOINT_ID.test(m['id'])) throw new Error('invalid checkpoint id')
  if (typeof m['name'] !== 'string' || m['name'].length === 0 || [...m['name']].length > 80) throw new Error('invalid checkpoint name')
  if (typeof m['createdAt'] !== 'number' || !Number.isFinite(m['createdAt'])) throw new Error('invalid checkpoint time')
  if (m['scope'] !== 'one' && m['scope'] !== 'all') throw new Error('invalid checkpoint scope')
  if (typeof m['automatic'] !== 'boolean') throw new Error('invalid checkpoint origin')
  const doc = parseWorkspaceFile(text)
  return { ...doc, checkpoint: { id: m['id'], name: m['name'], createdAt: m['createdAt'], scope: m['scope'], automatic: m['automatic'] } }
}

export function serializeCheckpoint(doc: WorkspaceDoc, checkpoint: CheckpointMeta): string {
  return JSON.stringify({ ...doc, checkpoint })
}
