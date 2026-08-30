import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PocketNewSessionSheet, PocketSessionSheet } from './PocketSheets'
import type { CommandCenterItem } from './commandCenter'

const item: CommandCenterItem = {
  pane: {
    name: 'amber-1-2-0-x', cwd: '/home/u/api', kind: 'claude', alive: true,
    ord: 0, deadCode: null, runState: 'claude', slot: 4,
  },
  ws: 1,
  tab: 2,
  group: 'working',
  stateLabel: 'Claude working',
  unseenActivity: false,
  activitySeq: 0,
  urgency: 0,
}

describe('PocketSessionSheet', () => {
  it('names the session and exposes ordered, explicit actions', () => {
    const html = renderToStaticMarkup(createElement(PocketSessionSheet, {
      item,
      title: 'api-refactor',
      parked: false,
      onOpen: () => {},
      onTogglePark: () => {},
      onCopyCwd: () => {},
      onShowMosaic: () => {},
      onCloseSession: () => {},
      onDismiss: () => {},
    }))
    expect(html).toContain('aria-label="Actions for api-refactor"')
    expect(html.indexOf('Open terminal')).toBeLessThan(html.indexOf('Freeze session'))
    expect(html.indexOf('Freeze session')).toBeLessThan(html.indexOf('Copy working directory'))
    expect(html.indexOf('Copy working directory')).toBeLessThan(html.indexOf('Close session'))
    expect(html).toContain('/home/u/api')
  })

  it('does not offer freeze when the agent has already fallen back to a shell', () => {
    const fallback = { ...item, pane: { ...item.pane, runState: 'shell-fallback' } }
    const html = renderToStaticMarkup(createElement(PocketSessionSheet, {
      item: fallback,
      title: 'api-refactor',
      parked: false,
      onOpen: () => {},
      onTogglePark: () => {},
      onCopyCwd: () => {},
      onShowMosaic: () => {},
      onCloseSession: () => {},
      onDismiss: () => {},
    }))
    expect(html).not.toContain('Freeze session')
    expect(html).not.toContain('Resume session')
  })

  it('offers resume for a parked agent', () => {
    const html = renderToStaticMarkup(createElement(PocketSessionSheet, {
      item,
      title: 'api-refactor',
      parked: true,
      onOpen: () => {},
      onTogglePark: () => {},
      onCopyCwd: () => {},
      onShowMosaic: () => {},
      onCloseSession: () => {},
      onDismiss: () => {},
    }))
    expect(html).toContain('Resume session')
    expect(html).not.toContain('Freeze session')
  })
})

describe('PocketNewSessionSheet', () => {
  it('lists only daemon-backed mobile kinds and names the destination', () => {
    const html = renderToStaticMarkup(createElement(PocketNewSessionSheet, {
      defaultKind: 'shell',
      cwd: '/home/u/api',
      destination: 'platform / release',
      onChooseCwd: () => {},
      onCreate: () => {},
      onDismiss: () => {},
    }))
    for (const kind of ['Shell', 'Claude', 'Grok', 'Codex', 'OpenCode', 'Hermes', 'Pi']) {
      expect(html).toContain(kind)
    }
    expect(html).not.toContain('Browser')
    expect(html).not.toContain('Editor')
    expect(html).toContain('Create shell')
    expect(html).toContain('platform / release')
    expect(html).toContain('/home/u/api')
  })
})
