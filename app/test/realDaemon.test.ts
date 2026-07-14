// Headless walking-skeleton proof: the TS Connection speaks the wire protocol
// to the REAL Rust amber daemon (not the fake), attaches a live shell session,
// and round-trips input->pty->output. This exercises exactly the custom risk
// (proto byte-parity + Attach + Data demux) minus Electron/xterm glue.
//
// Requires a running daemon and a live session. Gated behind AMBER_REAL_DAEMON
// so it never runs in ordinary CI. Run:
//   AMBER_REAL_DAEMON=1 AMBER_SESSION=amber-1-1-0-a npx vitest run test/realDaemon.test.ts
import { describe, it, expect } from 'vitest'
import { Connection } from '../src/client/connection'
import type { Frame } from '../src/shared/proto'
import { resolveSocketPath as resolvePath } from '../src/shared/socketPath'

const RUN = process.env['AMBER_REAL_DAEMON'] === '1'
const SESSION = process.env['AMBER_SESSION'] ?? 'amber-1-1-0-a'

describe.runIf(RUN)('real daemon', () => {
  it('attaches a live session and round-trips input to output', async () => {
    const path = resolvePath(process.env)
    const conn = new Connection(path)
    const output: number[] = []
    conn.on('frame', (f: Frame) => {
      if (f.type === 'data' && f.session === SESSION) output.push(...f.bytes)
    })
    conn.connect()
    conn.send({ type: 'control', msg: { kind: 'Attach', name: SESSION } })

    // Give the attach + backlog a beat, then type a command.
    await new Promise((r) => setTimeout(r, 200))
    const marker = 'AMBERPROOF_' + SESSION.replace(/[^a-zA-Z0-9]/g, '')
    conn.send({
      type: 'data',
      session: SESSION,
      bytes: new TextEncoder().encode(`echo ${marker}\n`),
    })

    // Collect output for up to 3s or until the marker echoes back.
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const text = new TextDecoder().decode(new Uint8Array(output))
      // The shell echoes the typed line AND prints the command output, so the
      // marker appears at least twice once the command has run.
      if ((text.match(new RegExp(marker, 'g')) ?? []).length >= 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    conn.close()

    const text = new TextDecoder().decode(new Uint8Array(output))
    expect(text).toContain(marker)
  })
})
