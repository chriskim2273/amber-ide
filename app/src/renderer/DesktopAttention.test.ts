import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopAttention, attentionItems, attentionNames } from './DesktopAttention'
import type { CommandCenterItem, CommandCenterModel } from './commandCenter'
import type { PaneModel } from './store'

function item(name: string, group: CommandCenterItem['group'], stateLabel: string, slot: number): CommandCenterItem {
  const pane: PaneModel = {
    name, cwd: `/home/u/${name}`, kind: group === 'parked' ? 'claude' : 'shell', alive: true,
    ord: slot, deadCode: null, runState: group === 'parked' ? 'memory-suspended' : 'claude', slot,
  }
  return { pane, ws: slot, tab: 1, group, stateLabel, unseenActivity: false, activitySeq: slot, urgency: 0 }
}

const needs = item('retrying-api', 'needs-you', 'Session retrying', 1)
const working = item('build', 'working', 'Recent output', 2)
const parked = item('agent', 'parked', 'Parked to protect system memory', 3)
const quiet = item('docs', 'quiet', 'Quiet shell', 4)
const model: CommandCenterModel = {
  count: 4,
  alerts: [],
  groups: [
    { id: 'needs-you', label: 'Needs you', items: [needs] },
    { id: 'working', label: 'Working', items: [working] },
    { id: 'parked', label: 'Parked', items: [parked] },
    { id: 'quiet', label: 'Quiet', items: [quiet] },
  ],
}

describe('desktop attention projection', () => {
  it('shows actionable groups but excludes quiet sessions from the compact surface', () => {
    expect(attentionItems(model)).toEqual([needs, working, parked])
    expect(attentionNames(model)).toEqual(new Set(['retrying-api']))
  })
})

describe('DesktopAttention', () => {
  it('renders machine state, location, native row controls and the all-sessions exit', () => {
    const onOpen = vi.fn()
    const html = renderToStaticMarkup(createElement(DesktopAttention, {
      model,
      titles: { 'retrying-api': 'API recovery' },
      workspaceLabels: { 1: 'Ophie', 2: 'Builds', 3: 'Agents' },
      tabLabels: { '1:1': 'release', '2:1': 'CI', '3:1': 'agents' },
      home: '/home/u',
      onOpen,
      onViewAll: () => {},
    }))
    expect(html).toContain('Needs you')
    expect(html).toContain('Working')
    expect(html).toContain('Parked')
    expect(html).not.toContain('Quiet shell')
    expect(html).toContain('API recovery')
    expect(html).toContain('Ophie / release')
    expect(html).toContain('aria-label="Show API recovery"')
    expect(html).toContain('View all sessions')
    expect(onOpen).not.toHaveBeenCalled()
  })
})
