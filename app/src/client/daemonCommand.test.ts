import { describe, it, expect } from 'vitest'
import type { Frame } from '../shared/proto'

// `commands.ts` holds the mapping precisely so this test needs no live socket:
// importing `index.ts` would boot the utility process's parent port.
import { handleDaemonCommand, type DaemonCommand } from './commands'

function sent(cmd: DaemonCommand): Frame[] {
  const out: Frame[] = []
  handleDaemonCommand({ send: (f: Frame) => out.push(f) }, cmd)
  return out
}

describe('handleDaemonCommand', () => {
  it('maps the getUsage gesture to a GetUsage control message', () => {
    expect(sent({ cmd: 'getUsage' })).toEqual([{ type: 'control', msg: { kind: 'GetUsage' } }])
  })

  it('still maps the gestures it already carried', () => {
    expect(sent({ cmd: 'kill', name: 's' })).toEqual([
      { type: 'control', msg: { kind: 'Kill', name: 's' } },
    ])
    expect(sent({ cmd: 'snapshot' })).toEqual([{ type: 'control', msg: { kind: 'Snapshot' } }])
    expect(sent({ cmd: 'getMemoryBudget' })).toEqual([
      { type: 'control', msg: { kind: 'GetMemoryBudget' } },
    ])
  })
})
