import { describe, it, expect } from 'vitest'
import { encode, Decoder, type Frame } from './proto'

function roundtrip(f: Frame): Frame {
  const d = new Decoder()
  d.feed(encode(f))
  const out = d.next()
  if (!out) throw new Error('no frame')
  return out
}

describe('proto', () => {
  it('roundtrips a control frame', () => {
    const f: Frame = { type: 'control', msg: { kind: 'WatchSessions' } }
    expect(roundtrip(f)).toEqual(f)
  })

  it('roundtrips a data frame preserving raw bytes', () => {
    const bytes = new Uint8Array([0, 1, 255, 0, 27, 91, 50, 74])
    const f: Frame = { type: 'data', session: 's', bytes }
    const out = roundtrip(f)
    expect(out).toEqual({ type: 'data', session: 's', bytes })
  })

  it('encodes control JSON externally-tagged to match serde', () => {
    // Attach{name} -> {"Attach":{"name":"a"}}; body = [tag=0][json]
    const f: Frame = { type: 'control', msg: { kind: 'Attach', name: 'a' } }
    const wire = encode(f)
    const bodyLen = new DataView(wire.buffer).getUint32(0, false)
    const body = wire.slice(4, 4 + bodyLen)
    expect(body[0]).toBe(0) // TAG_CONTROL
    const json = new TextDecoder().decode(body.slice(1))
    expect(json).toBe('{"Attach":{"name":"a"}}')
  })

  it('parses a Sessions reply', () => {
    const f: Frame = {
      type: 'control',
      msg: { kind: 'Sessions', sessions: [{ name: 'amber-1-1-0-a', cwd: '/tmp', kind: 'shell', alive: true }] },
    }
    expect(roundtrip(f)).toEqual(f)
  })

  it('roundtrips an Activity control frame (daemon -> app)', () => {
    const f: Frame = { type: 'control', msg: { kind: 'Activity', name: 'amber-1-1-0-a' } }
    expect(roundtrip(f)).toEqual(f)
    // Lock the externally-tagged shape the daemon emits.
    const wire = encode(f)
    const bodyLen = new DataView(wire.buffer).getUint32(0, false)
    const json = new TextDecoder().decode(wire.slice(5, 4 + bodyLen))
    expect(json).toBe('{"Activity":{"name":"amber-1-1-0-a"}}')
  })

  it('encodes DumpBacklog externally-tagged to match serde', () => {
    const f: Frame = { type: 'control', msg: { kind: 'DumpBacklog', name: 's' } }
    const wire = encode(f)
    const bodyLen = new DataView(wire.buffer).getUint32(0, false)
    const json = new TextDecoder().decode(wire.slice(5, 4 + bodyLen))
    expect(json).toBe('{"DumpBacklog":{"name":"s"}}')
  })

  it('decodes a Backlog reply (Vec<u8> as numeric array) into a Uint8Array', () => {
    // Mirror serde's exact JSON: {"Backlog":{"name":"s","data":[0,65,255]}}.
    const json = '{"Backlog":{"name":"s","data":[0,65,255]}}'
    const jsonBytes = new TextEncoder().encode(json)
    const body = new Uint8Array(1 + jsonBytes.length)
    body[0] = 0 // TAG_CONTROL
    body.set(jsonBytes, 1)
    const wire = new Uint8Array(4 + body.length)
    new DataView(wire.buffer).setUint32(0, body.length, false)
    wire.set(body, 4)

    const d = new Decoder()
    d.feed(wire)
    const out = d.next()
    expect(out).toEqual({
      type: 'control',
      msg: { kind: 'Backlog', name: 's', data: new Uint8Array([0, 65, 255]) },
    })
  })

  it('roundtrips a Backlog frame preserving raw bytes', () => {
    const f: Frame = {
      type: 'control',
      msg: { kind: 'Backlog', name: 's', data: new Uint8Array([0, 1, 255, 27, 91, 50, 74]) },
    }
    expect(roundtrip(f)).toEqual(f)
  })

  it('decodes byte-at-a-time and across chunk splits', () => {
    const f: Frame = { type: 'data', session: 's', bytes: new Uint8Array([10, 13, 0, 255]) }
    const wire = encode(f)
    const d = new Decoder()
    for (const b of wire) {
      expect(d.next()).toBeNull()
      d.feed(new Uint8Array([b]))
    }
    expect(d.next()).toEqual(f)
  })

  it('rejects an oversized length prefix', () => {
    const d = new Decoder()
    const bad = new Uint8Array(5)
    new DataView(bad.buffer).setUint32(0, 64 * 1024 * 1024 + 1, false)
    d.feed(bad)
    expect(() => d.next()).toThrow()
  })
})
