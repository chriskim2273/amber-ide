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
