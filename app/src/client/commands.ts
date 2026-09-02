// The renderer's control gestures, and the one place each becomes a daemon
// control message.
//
// Its own module because `index.ts` wires a live socket and
// `process.parentPort` at import time: a test that imported the mapping from
// there would boot the whole utility process.

import type { Frame } from '../shared/proto'

/**
 * Every control gesture the renderer can ask for, as it arrives over the
 * control MessagePort.
 */
export type DaemonCommand =
  | { cmd: 'create'; name: string; cwd: string; sessionKind: string }
  | { cmd: 'kill'; name: string }
  | { cmd: 'rename'; from: string; to: string }
  | { cmd: 'dumpBacklog'; name: string }
  | { cmd: 'searchScrollback'; requestId: number; query: string; names: string[]; limit: number }
  | { cmd: 'listRecoveryEvents'; limit: number }
  | { cmd: 'clearRecoveryEvents' }
  | { cmd: 'suspend'; name: string }
  | { cmd: 'resume'; name: string }
  | { cmd: 'focus'; name: string }
  | { cmd: 'getMemoryBudget' }
  | { cmd: 'setMemoryBudget'; mb: number }
  | { cmd: 'snapshot' }
  // Agent plan quota; the daemon answers from its poller cache with `Usage`.
  | { cmd: 'getUsage' }

/**
 * Map one renderer gesture onto the control message it sends. Extracted from
 * the port handler so the mapping is testable without a live socket — this is
 * the one place a gesture becomes a daemon message.
 */
export function handleDaemonCommand(conn: { send: (f: Frame) => void }, cmd: DaemonCommand): void {
  if (cmd.cmd === 'create') {
    conn.send({ type: 'control', msg: { kind: 'Create', name: cmd.name, cwd: cmd.cwd, sessionKind: cmd.sessionKind } })
  } else if (cmd.cmd === 'kill') {
    conn.send({ type: 'control', msg: { kind: 'Kill', name: cmd.name } })
  } else if (cmd.cmd === 'rename') {
    conn.send({ type: 'control', msg: { kind: 'Rename', from: cmd.from, to: cmd.to } })
  } else if (cmd.cmd === 'dumpBacklog') {
    conn.send({ type: 'control', msg: { kind: 'DumpBacklog', name: cmd.name } })
  } else if (cmd.cmd === 'searchScrollback') {
    conn.send({
      type: 'control',
      msg: {
        kind: 'SearchScrollback', request_id: cmd.requestId,
        query: cmd.query, names: cmd.names, limit: cmd.limit,
      },
    })
  } else if (cmd.cmd === 'listRecoveryEvents') {
    conn.send({ type: 'control', msg: { kind: 'ListRecoveryEvents', limit: cmd.limit } })
  } else if (cmd.cmd === 'clearRecoveryEvents') {
    conn.send({ type: 'control', msg: { kind: 'ClearRecoveryEvents' } })
  } else if (cmd.cmd === 'suspend') {
    conn.send({ type: 'control', msg: { kind: 'Suspend', name: cmd.name } })
  } else if (cmd.cmd === 'resume') {
    conn.send({ type: 'control', msg: { kind: 'Resume', name: cmd.name } })
  } else if (cmd.cmd === 'focus') {
    conn.send({ type: 'control', msg: { kind: 'Focus', name: cmd.name } })
  } else if (cmd.cmd === 'getMemoryBudget') {
    conn.send({ type: 'control', msg: { kind: 'GetMemoryBudget' } })
  } else if (cmd.cmd === 'setMemoryBudget') {
    conn.send({ type: 'control', msg: { kind: 'SetMemoryBudget', mb: cmd.mb } })
  } else if (cmd.cmd === 'snapshot') {
    conn.send({ type: 'control', msg: { kind: 'Snapshot' } })
  } else if (cmd.cmd === 'getUsage') {
    conn.send({ type: 'control', msg: { kind: 'GetUsage' } })
  }
}
