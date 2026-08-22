import { describe, it, expect } from 'vitest'
import { webCtlArgv, parseWebStatus, redactUrl } from './webService'

describe('webCtlArgv', () => {
  it('always asks for json and passes the port', () => {
    expect(webCtlArgv('status', 7717)).toEqual(['ctl', 'web', 'status', '--json', '--port', '7717'])
  })
})

describe('parseWebStatus', () => {
  const ok = JSON.stringify({
    unit: 'active',
    port: 7717,
    url: 'https://desk.ts.net/app',
    has_token: true,
    tailscale: 'serving',
    host: 'desk.ts.net',
    clients: [{ id: 3, open: 'amber-1-1-0-ab', borrow: null }],
    sessions: 6,
    uptime_secs: 90,
    error: null,
  })

  it('maps snake_case to camelCase and keeps the client list', () => {
    const s = parseWebStatus(ok)
    expect(s.unit).toBe('active')
    expect(s.uptimeSecs).toBe(90)
    expect(s.clients[0]?.open).toBe('amber-1-1-0-ab')
    expect(s.hasToken).toBe(true)
  })

  it('never carries a token, so the dialog must fetch one on demand', () => {
    expect(parseWebStatus(ok).url).not.toContain('#t=')
  })

  it('never throws on garbage — a broken CLI must not kill the dialog', () => {
    const s = parseWebStatus('not json at all')
    expect(s.unit).toBe('unknown')
    expect(s.error).toBeTruthy()
  })

  it('rejects an unknown tailscale label instead of trusting it', () => {
    const s = parseWebStatus(JSON.stringify({ unit: 'active', tailscale: 'wat' }))
    expect(s.tailscale).toBe('not-installed')
  })

  it('survives a client array of the wrong shape', () => {
    const s = parseWebStatus(JSON.stringify({ clients: [{}, { id: 'x', open: 5 }] }))
    expect(s.clients).toHaveLength(2)
    expect(s.clients[1]?.id).toBe(0)
    expect(s.clients[1]?.open).toBeNull()
  })
})

describe('redactUrl', () => {
  it('hides the fragment token for anything that gets logged', () => {
    expect(redactUrl('https://desk.ts.net/app#t=secret123')).toBe('https://desk.ts.net/app#t=…')
  })
  it('leaves a token-free url alone', () => {
    expect(redactUrl('https://desk.ts.net/app')).toBe('https://desk.ts.net/app')
  })
})

describe('managed', () => {
  it('defaults to managed on the desktop side', () => {
    expect(parseWebStatus(JSON.stringify({ unit: 'active' })).managed).toBe(true)
  })
})
