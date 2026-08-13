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
  function decodeControlJson(json: string): Frame {
    const jsonBytes = new TextEncoder().encode(json)
    const wire = new Uint8Array(5 + jsonBytes.length)
    new DataView(wire.buffer).setUint32(0, 1 + jsonBytes.length, false)
    wire[4] = 0
    wire.set(jsonBytes, 5)
    const d = new Decoder()
    d.feed(wire)
    const frame = d.next()
    if (!frame) throw new Error('no frame')
    return frame
  }

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
    // Attach{name} -> {"Attach":{"name":"a"}}; body = [tag=0][json]. The app
    // never sets `raw_client` or `preview` (mosaic-tile attach, spec
    // 2026-08-01), so both are omitted and the daemon's `#[serde(default)]`
    // decodes the absence as false for each.
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

  it('roundtrips Focus in the exact Rust serde shape', () => {
    const f: Frame = { type: 'control', msg: { kind: 'Focus', name: 's' } }
    expect(roundtrip(f)).toEqual(f)
    const wire = encode(f)
    const bodyLen = new DataView(wire.buffer).getUint32(0, false)
    expect(new TextDecoder().decode(wire.slice(5, 4 + bodyLen)))
      .toBe('{"Focus":{"name":"s"}}')
  })

  it('decodes MemoryPressure with additive numeric and boolean defaults', () => {
    expect(decodeControlJson('{"MemoryPressure":{"level":"warning"}}')).toEqual({
      type: 'control',
      msg: { kind: 'MemoryPressure', level: 'warning', current_kb: 0, budget_kb: 0, blocked: false },
    })
    const full: Frame = {
      type: 'control',
      msg: { kind: 'MemoryPressure', level: 'critical', current_kb: 7_000_000, budget_kb: 8_000_000, blocked: true },
    }
    expect(roundtrip(full)).toEqual(full)
  })

  it('rejects an unknown MemoryPressure level', () => {
    expect(() => decodeControlJson('{"MemoryPressure":{"level":"severe"}}'))
      .toThrow(/pressure level/)
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

  it('does not re-copy the pending buffer on every feed', () => {
    // feed() used to allocate a whole new Uint8Array of (buffered + chunk) per
    // socket chunk, so accumulating one big frame was O(n^2): a 2 MiB Attach
    // backlog arriving in 64 KiB chunks copied ~32 MB through the allocator to
    // receive 2 MB. That is the utilityProcess's single largest garbage source.
    //
    // Asserted by counting bytes copied, which is the property that matters and
    // is stable across implementations: total copying to assemble one frame must
    // stay within a small constant multiple of the frame, not scale with the
    // square of the chunk count.
    const CHUNK = 64 * 1024
    const CHUNKS = 32
    const payload = new Uint8Array(CHUNK * CHUNKS)
    const wire = encode({ type: 'data', session: 's', bytes: payload })

    let copied = 0
    const realSet = Uint8Array.prototype.set
    // Count every bulk copy the decoder performs while assembling the frame.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Uint8Array.prototype as any).set = function (this: Uint8Array, src: ArrayLike<number>, off?: number) {
      copied += (src as ArrayLike<number>).length ?? 0
      return realSet.call(this, src as never, off as never)
    }
    try {
      const d = new Decoder()
      for (let i = 0; i < wire.length; i += CHUNK) d.feed(wire.subarray(i, i + CHUNK))
      const out = d.next()
      expect(out?.type).toBe('data')
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Uint8Array.prototype as any).set = realSet
    }
    // Quadratic assembly copies ~CHUNKS/2 x the payload (~32 MB here). Linear
    // assembly copies it a small number of times. 4x is generous headroom that
    // still fails hard on the old behaviour.
    expect(copied).toBeLessThan(wire.length * 4)
  })

  it('releases buffered memory once frames are consumed', () => {
    // A read cursor alone would leak: the underlying buffer would keep every
    // frame ever received. Consumed bytes must actually be reclaimed, or a
    // long-lived pane connection grows without bound.
    const d = new Decoder()
    const f: Frame = { type: 'data', session: 's', bytes: new Uint8Array(64 * 1024) }
    for (let i = 0; i < 50; i++) {
      d.feed(encode(f))
      expect(d.next()).not.toBeNull()
      expect(d.next()).toBeNull()
    }
    expect(d.buffered()).toBe(0)
  })

  it('roundtrips a backlog frame on its own binary tag', () => {
    // A scrollback dump no longer rides ControlMsg.Backlog, whose serde form is
    // a JSON numeric array: a 2 MiB ring arrived as ~8 MB of decimal text and
    // was parsed into a 2-million-element Array before Uint8Array.from.
    const f: Frame = { type: 'backlog', session: 'amber-1-1-0-a', bytes: new Uint8Array([0, 27, 91, 255, 10]) }
    expect(roundtrip(f)).toEqual(f)
    expect(encode(f)[4]).toBe(2) // TAG_BACKLOG
  })

  it('keeps backlog and data frames distinct with identical payloads', () => {
    // Same body layout, so a decode that ignored the tag would write a
    // scrollback dump straight into the pane's terminal.
    const bytes = new Uint8Array([1, 2, 3])
    const d: Frame = { type: 'data', session: 's', bytes }
    const b: Frame = { type: 'backlog', session: 's', bytes }
    expect(encode(d)).not.toEqual(encode(b))
    expect(roundtrip(d)).toEqual(d)
    expect(roundtrip(b)).toEqual(b)
  })

  it('still decodes a legacy JSON Backlog control message', () => {
    // Back-compat: a NEW app talking to an OLDER daemon must still understand
    // the numeric-array form.
    const f: Frame = { type: 'control', msg: { kind: 'Backlog', name: 's', data: new Uint8Array([7, 8]) } }
    expect(roundtrip(f)).toEqual(f)
  })

  it('rejects a truncated data/backlog frame instead of reading past it', () => {
    // The read buffer is intentionally over-sized for reuse, so a corrupt length
    // prefix must be caught explicitly — otherwise the name header is read from
    // whatever bytes happen to follow, and the frame decodes to a garbage
    // session name rather than an error.
    for (const tag of [1, 2]) {
      const d = new Decoder()
      d.feed(new Uint8Array([0, 0, 0, 1, tag])) // len=1: tag only, no name header
      expect(() => d.next()).toThrow(/truncated/)
    }
    // Name length that runs past the frame's own end.
    const d = new Decoder()
    d.feed(new Uint8Array([0, 0, 0, 3, 1, 0, 200])) // len=3, nameLen=200
    expect(() => d.next()).toThrow(/truncated/)
  })

  it('decodes several frames from one chunk', () => {
    // The cursor must advance frame-to-frame within a single fed chunk.
    const a: Frame = { type: 'data', session: 'a', bytes: new Uint8Array([1, 2]) }
    const b: Frame = { type: 'control', msg: { kind: 'Activity', name: 'x' } }
    const wa = encode(a), wb = encode(b)
    const both = new Uint8Array(wa.length + wb.length)
    both.set(wa, 0); both.set(wb, wa.length)
    const d = new Decoder()
    d.feed(both)
    expect(d.next()).toEqual(a)
    expect(d.next()).toEqual(b)
    expect(d.next()).toBeNull()
  })
})
