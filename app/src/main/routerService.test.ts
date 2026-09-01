import { describe, expect, it } from 'vitest'
import { parseRouterStatus, routerCtlArgv } from './routerService'
import { moveSlot, routerDot, slotFromWire, slotToWire } from '../shared/routerStatus'
import type { RouterSlot, RouterStatus } from '../shared/routerStatus'

const base: RouterStatus = {
  managed: true,
  unit: 'inactive',
  port: 7719,
  url: 'http://127.0.0.1:7719/v1',
  alias: 'auto',
  hasToken: false,
  pi: 'missing',
  slots: [],
  keys: [],
  queueAvailable: null,
  uptimeSecs: null,
  error: null,
}

function slot(id: string, enabled = true): RouterSlot {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example/v1`,
    model: 'm',
    enabled,
    hasKey: true,
    keyHint: '••••1234',
  }
}

describe('routerCtlArgv', () => {
  it('always asks for JSON and names the port', () => {
    expect(routerCtlArgv('status', 7719)).toEqual([
      'ctl',
      'router',
      'status',
      '--json',
      '--port',
      '7719',
    ])
  })
})

describe('parseRouterStatus', () => {
  it('never throws on garbage', () => {
    const s = parseRouterStatus('not json at all')
    expect(s.unit).toBe('unknown')
    expect(s.error).toMatch(/could not parse/)
  })

  it('reads a real status payload', () => {
    const s = parseRouterStatus(
      JSON.stringify({
        managed: true,
        unit: 'active',
        port: 7799,
        url: 'http://127.0.0.1:7799/v1',
        alias: 'auto',
        has_token: true,
        pi: 'installed',
        uptime_secs: 31,
        queue_available: 256,
        slots: [
          {
            id: 'abc',
            name: 'alpha',
            base_url: 'http://127.0.0.1:7801',
            model: 'm-a',
            enabled: true,
            has_key: true,
            key_hint: '••••1111',
          },
        ],
        keys: [
          {
            label: 'alpha#0',
            state: 'cooling',
            cooling_secs_remaining: 19,
            in_flight: 0,
            requests: 2,
            errors: 1,
            last_error: 'HTTP 429',
          },
        ],
        error: null,
      }),
    )
    expect(s.unit).toBe('active')
    expect(s.pi).toBe('installed')
    expect(s.slots[0]).toEqual({
      id: 'abc',
      name: 'alpha',
      baseUrl: 'http://127.0.0.1:7801',
      model: 'm-a',
      enabled: true,
      hasKey: true,
      keyHint: '••••1111',
    })
    expect(s.keys[0]?.coolingSecsRemaining).toBe(19)
    expect(s.uptimeSecs).toBe(31)
  })

  it('never surfaces a key or token even if the CLI regressed and sent one', () => {
    const s = parseRouterStatus(
      JSON.stringify({
        unit: 'active',
        slots: [{ id: 'a', name: 'a', api_key: 'sk-leaked', has_key: true }],
        token: 'tok-leaked',
      }),
    )
    const text = JSON.stringify(s)
    expect(text).not.toContain('sk-leaked')
    expect(text).not.toContain('tok-leaked')
  })

  it('falls back to a sane pi state and alias', () => {
    const s = parseRouterStatus(JSON.stringify({ unit: 'active', pi: 'nonsense' }))
    expect(s.pi).toBe('no-config')
    expect(s.alias).toBe('auto')
  })
})

describe('routerDot', () => {
  it('an inactive unit is off, not an error', () => {
    expect(routerDot({ ...base, unit: 'inactive', error: 'router unreachable' })).toBe('off')
  })

  it('an active unit that cannot be reached is an error', () => {
    expect(routerDot({ ...base, unit: 'active', error: 'router unreachable' })).toBe('error')
  })

  it('running with no enabled slot is local, with one is serving', () => {
    expect(routerDot({ ...base, unit: 'active' })).toBe('local')
    expect(routerDot({ ...base, unit: 'active', slots: [slot('a', false)] })).toBe('local')
    expect(routerDot({ ...base, unit: 'active', slots: [slot('a')] })).toBe('serving')
  })
})

describe('moveSlot', () => {
  it('moves without mutating the input', () => {
    const list = [slot('a'), slot('b'), slot('c')]
    const moved = moveSlot(list, 2, 0)
    expect(moved.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op out of range', () => {
    const list = [slot('a')]
    expect(moveSlot(list, 0, 5)).toBe(list)
    expect(moveSlot(list, -1, 0)).toBe(list)
    expect(moveSlot(list, 0, 0)).toBe(list)
  })
})

describe('wire mapping', () => {
  it('round-trips a slot through both directions', () => {
    const wire = {
      id: 'abc',
      name: 'alpha',
      base_url: 'https://a.example/v1',
      model: 'm',
      enabled: true,
      has_key: true,
      key_hint: '••••1111',
    }
    const ui = slotFromWire(wire)
    expect(ui.hasKey).toBe(true)
    expect(ui.baseUrl).toBe('https://a.example/v1')
    expect(ui.keyHint).toBe('••••1111')

    const back = slotToWire(ui, '')
    expect(back['base_url']).toBe('https://a.example/v1')
    expect(back['api_key']).toBe('')
    // The router only knows snake_case; a camelCase key would be rejected.
    expect(back['baseUrl']).toBeUndefined()
    expect(back['hasKey']).toBeUndefined()
  })

  it('sends a typed key and nothing else about the key', () => {
    const ui = slotFromWire({ id: 'a', name: 'a', base_url: 'https://x/v1', has_key: true })
    const back = slotToWire(ui, 'sk-typed')
    expect(back['api_key']).toBe('sk-typed')
    expect(JSON.stringify(back)).not.toContain('key_hint')
  })
})
