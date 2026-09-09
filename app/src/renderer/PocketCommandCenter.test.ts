import { act, createElement } from 'react'
import { withFakeDom } from './mountedTestDom'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PocketCommandCenter, usageLine, PocketFocusHeader, pocketSessionTitle, pocketSessionIdentity, pocketBadgeLabel } from './PocketCommandCenter'
import type { CommandCenterItem, CommandCenterModel } from './commandCenter'
import type { PaneModel } from './store'
import type { ProviderUsage } from '../shared/proto'

const pane: PaneModel = {
  name: 'amber-2-3-0-api', cwd: '/home/u/api', kind: 'pi', alive: true,
  ord: 0, deadCode: null, runState: 'claude', slot: 7,
}

const model: CommandCenterModel = {
  count: 1,
  alerts: [{ id: 'memory', level: 'critical', text: 'Memory pressure is critical.' }],
  groups: [
    { id: 'needs-you', label: 'Needs you', items: [] },
    {
      id: 'working', label: 'Working', items: [{
        pane, ws: 2, tab: 3, group: 'working', stateLabel: 'Pi working',
        unseenActivity: true, activitySeq: 4, urgency: 0, rssKb: 1_500_000, growing: true,
      }],
    },
    { id: 'parked', label: 'Parked', items: [] },
    { id: 'quiet', label: 'Quiet', items: [] },
  ],
}

function render(overrides: Partial<Parameters<typeof PocketCommandCenter>[0]> = {}): string {
  return renderToStaticMarkup(createElement(PocketCommandCenter, {
    model,
    loading: false,
    machineName: 'teapot-dev',
    connected: true,
    workspaceOptions: [{ ws: 2, label: 'platform' }, { ws: 4, label: 'infra' }],
    activeWorkspace: null,
    workspaceLabels: { 2: 'platform' },
    tabLabels: { '2:3': 'release' },
    titles: { 'amber-2-3-0-api': 'api-refactor' },
    home: '/home/u',
    usage: [],
    onWorkspace: () => {},
    onOpen: () => {},
    onOpenChat: () => {},
    onActions: () => {},
    onMosaic: () => {},
    onDesktop: () => {},
    onNew: () => {},
    ...overrides,
  }))
}

describe('pocketSessionTitle', () => {
  it('preserves U+FEFF in a valid friendly title', () => {
    const working = model.groups[1]!.items[0]!
    expect(pocketSessionTitle({ ...working, pane: { ...working.pane, title: '\uFEFFBuild\uFEFF' } }, {}, '/home/u')).toBe('\uFEFFBuild\uFEFF')
  })

  it('prefers a durable friendly title before live title and cwd fallbacks', () => {
    const working = model.groups[1]!.items[0]!
    expect(pocketSessionTitle({ ...working, pane: { ...working.pane, title: 'Release monitor' } }, { [working.pane.name]: 'live title' }, '/home/u')).toBe('Release monitor')
  })

  it('prefers a live title, then project leaf, then kind instead of a bare home marker', () => {
    const working = model.groups[1]!.items[0]!
    expect(pocketSessionTitle(working, { [working.pane.name]: 'live title' }, '/home/u')).toBe('live title')
    expect(pocketSessionTitle(working, {}, '/home/u')).toBe('api')
    expect(pocketSessionTitle({ ...working, pane: { ...working.pane, cwd: '/home/u' } }, {}, '/home/u')).toBe('Pi')
  })
})

describe('PocketFocusHeader', () => {
  it('shows both view choices with the current view selected', () => {
    const html = renderToStaticMarkup(createElement(PocketFocusHeader, {
      title: 'api', machineName: 'host', stateLabel: 'Working', piView: 'gui',
      onBack: () => {}, onActions: () => {}, onPiView: () => {},
    }))
    expect(html).toContain('aria-label="Pi view"')
    expect(html).toContain('aria-label="Show Pi chat" aria-pressed="true"')
    expect(html).toContain('aria-label="Show Pi terminal" aria-pressed="false"')
  })
  it('keeps back, machine identity and context actions explicit', () => {
    const html = renderToStaticMarkup(createElement(PocketFocusHeader, {
      title: 'api-refactor',
      machineName: 'teapot-dev',
      stateLabel: 'Pi working',
      onBack: () => {},
      onActions: () => {},
    }))
    expect(html).toContain('aria-label="Back to Sessions"')
    expect(html).toContain('api-refactor')
    expect(html).toContain('teapot-dev / Pi working')
    expect(html).toContain('aria-label="Actions for api-refactor"')
  })
})

describe('PocketCommandCenter', () => {
  it('dispatches one chat open for the selected session without the ordinary open action', async () => {
    await withFakeDom(async dom => {
      const { createRoot } = await import('react-dom/client')
      const root = createRoot(dom.container as unknown as Element)
      const onOpen = vi.fn()
      const onOpenChat = vi.fn()
      try {
        await act(async () => root.render(createElement(PocketCommandCenter, {
          model, loading: false, machineName: 'phone', connected: true,
          workspaceOptions: [], activeWorkspace: null, workspaceLabels: {}, tabLabels: {},
          titles: {}, home: '/home/u', usage: [], onWorkspace: () => {},
          onOpen, onOpenChat, onActions: () => {}, onMosaic: () => {},
          onDesktop: () => {}, onNew: () => {},
        })))
        const chat = dom.container.querySelector('[aria-label="Open chat for api"]')
        expect(chat).not.toBeNull()
        await act(async () => { chat!.click() })
        expect(onOpenChat).toHaveBeenCalledTimes(1)
        expect(onOpenChat).toHaveBeenCalledWith(model.groups[1]!.items[0])
        expect(onOpen).not.toHaveBeenCalled()
        const open = dom.container.querySelector('[aria-label="Open api"]')
        await act(async () => { open!.click() })
        expect(onOpen).toHaveBeenCalledTimes(1)
        expect(onOpen).toHaveBeenCalledWith(model.groups[1]!.items[0])
      } finally {
        await act(async () => root.unmount())
      }
    }, true)
  })
  it('offers direct chat only for live Pi sessions', () => {
    expect(render()).toContain('aria-label="Open chat for api-refactor"')
    for (const change of [{ kind: 'shell' }, { alive: false }, { deadCode: 0 }]) {
      const altered = { ...model, groups: model.groups.map(group => ({ ...group,
        items: group.items.map(item => ({ ...item, pane: { ...item.pane, ...change } })),
      })) }
      expect(render({ model: altered })).not.toContain('Open chat for')
    }
  })
  it('renders machine truth, urgency and session identity', () => {
    const html = render()
    expect(html).toContain('teapot-dev')
    expect(html).toContain('Connected')
    expect(html).toContain('Memory pressure is critical.')
    expect(html).toContain('api-refactor')
    // State is a badge on the row now, not a section the row lives in — and it
    // drops the kind the row's chip already shows.
    expect(html).toContain('working')
    expect(html).not.toContain('Pi working')
    expect(html).toContain('#7')
    // Group headers and the zero-state card are gone: they consumed the
    // vertical budget that the row needs to identify itself, and the group
    // decided a row's position, which is what made rows jump.
    expect(html).not.toContain('Nothing needs you')
    expect(html).not.toContain('pocket-group-head')
  })

  it('exposes named touch actions and bottom navigation', () => {
    const html = render()
    expect(html).toContain('aria-label="Open api-refactor"')
    expect(html).toContain('aria-label="Actions for api-refactor"')
    expect(html).toContain('aria-label="Workspace filter"')
    expect(html).toContain('aria-label="Pocket navigation"')
    expect(html).toContain('>Sessions<')
    expect(html).toContain('>Mosaic<')
    expect(html).toContain('aria-label="Full desktop view"')
    expect(html).toContain('>Desktop<')
    expect(html).toContain('>New<')
  })

  it('shows a shaped loading state instead of flashing an empty command center', () => {
    const html = render({ loading: true, model: { ...model, count: 0 } })
    expect(html).toContain('Connecting to Amber')
    expect(html).not.toContain('No terminal sessions here')
  })

  it('renders a useful empty state when the filter has no daemon panes', () => {
    const empty: CommandCenterModel = {
      count: 0,
      alerts: [],
      groups: model.groups.map((group) => ({ ...group, items: [] })),
    }
    const html = render({ model: empty, activeWorkspace: 4 })
    expect(html).toContain('No terminal sessions here')
    expect(html).toContain('Create a session or choose another workspace.')
  })

  it('does not invoke callbacks while rendering', () => {
    const onOpen = vi.fn()
    const onMosaic = vi.fn()
    const onDesktop = vi.fn()
    render({ onOpen, onMosaic, onDesktop })
    expect(onOpen).not.toHaveBeenCalled()
    expect(onMosaic).not.toHaveBeenCalled()
    expect(onDesktop).not.toHaveBeenCalled()
  })
})

describe('usageLine', () => {
  const row = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
    provider: 'claude', plan: 'pro', gauges: [], updated: 0, state: 'ok', detail: null, ...over,
  })

  it('shows a compact line for the tightest live gauge', () => {
    expect(usageLine([
      row({ gauges: [{ kind: 'session', label: '5h window', percent: 15, resets_at: null, stale: false }] }),
    ])).toBe('claude 85% left')
  })

  it('shows nothing when no provider reports a gauge', () => {
    expect(usageLine([
      row({ provider: 'grok', state: 'unavailable', plan: null, detail: 'grok exposes no quota data' }),
    ])).toBeNull()
    expect(usageLine([])).toBeNull()
  })
})

describe('pocketSessionIdentity', () => {
  const item = (overrides: Partial<PaneModel> = {}) => ({
    pane: {
      name: 'amber-1-1-0-a', cwd: '/home/u/Projects/amber-ide', kind: 'pi',
      alive: true, ord: 0, deadCode: null, slot: 2, ...overrides,
    },
  } as CommandCenterItem)

  it('names the project, the branch and the kind', () => {
    const id = pocketSessionIdentity(item({ branch: 'feat/pocket-mobile-ux' }), '/home/u')
    expect(id.project).toBe('amber-ide')
    expect(id.branch).toBe('feat/pocket-mobile-ux')
    expect(id.kind).toBe('pi')
  })

  it('separates two panes in the same repository', () => {
    // The reported problem: identical project, kind and slot-adjacent rows that
    // cannot be told apart without opening them.
    const a = pocketSessionIdentity(item({ branch: 'main' }), '/home/u')
    const b = pocketSessionIdentity(item({ branch: 'fix/pi-session-recovery', slot: 3 }), '/home/u')
    expect(a.project).toBe(b.project)
    expect(a.branch).not.toBe(b.branch)
  })

  it('omits the branch outside a repository rather than showing an empty field', () => {
    expect(pocketSessionIdentity(item({ branch: undefined }), '/home/u').branch).toBeUndefined()
    expect(pocketSessionIdentity(item({ branch: '   ' }), '/home/u').branch).toBeUndefined()
  })

  it('falls back to the home marker when the cwd is home itself', () => {
    expect(pocketSessionIdentity(item({ cwd: '/home/u' }), '/home/u').project).toBe('~')
  })
})

describe('pocketBadgeLabel', () => {
  const item = (stateLabel: string, kind = 'pi') =>
    ({ stateLabel, pane: { kind } } as CommandCenterItem)

  it('drops the kind the row already shows', () => {
    // "Pi exited to shell" next to a `pi` chip spends the badge's width saying
    // the same word twice, and then truncates to "Pi exited to s...".
    expect(pocketBadgeLabel(item('Pi exited to shell'))).toBe('exited to shell')
    expect(pocketBadgeLabel(item('Pi working'))).toBe('working')
    expect(pocketBadgeLabel(item('Claude retrying', 'claude'))).toBe('retrying')
  })

  it('leaves a label that does not start with the kind alone', () => {
    expect(pocketBadgeLabel(item('Session exited'))).toBe('Session exited')
    expect(pocketBadgeLabel(item('Frozen by you'))).toBe('Frozen by you')
    expect(pocketBadgeLabel(item('Parked to protect system memory'))).toBe('Parked to protect system memory')
  })

  it('never returns an empty badge', () => {
    expect(pocketBadgeLabel(item('Pi'))).toBe('Pi')
  })
})
