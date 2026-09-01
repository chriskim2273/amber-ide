import { describe, expect, it } from 'vitest'
import { TabBrowserHost, type TabBrowserPage, type TabBrowserPageEvent, type TabBrowserPageFactory } from './tabBrowserHost'
import { emptyBrowserState } from '../shared/tabBrowserState'

class FakePage implements TabBrowserPage {
  url = 'about:blank'; destroyed = false; visible = false; stopped = false
  async loadURL(url: string) { this.url = url }
  show() { this.visible = true }
  hide() { this.visible = false }
  stop() { this.stopped = true }
  destroy() { this.destroyed = true }
}

const userInputs = new Map<string, () => void>()
const pageEvents = new Map<string, (event: TabBrowserPageEvent) => void>()
const factory: TabBrowserPageFactory = { create: (id, onUserInput, onPageEvent) => { userInputs.set(id, onUserInput); pageEvents.set(id, onPageEvent); return new FakePage() } }

describe('TabBrowserHost', () => {
  it('normalizes persisted live records to frozen until a renderer is recreated', () => {
    const state = emptyBrowserState(1)
    state.records['browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] = {
      id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', profileId: 'global', mode: 'browse', safeRestoreUrl: 'https://example.test/', title: '',
      viewport: { width: 800, height: 600 }, lifecycle: 'live', stateRevision: 1, lastUsedAt: 1, lastFocusedAt: 1,
    }
    const host = new TabBrowserHost(state, factory)
    expect(host.status('browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').lifecycle).toBe('frozen')
  })

  it('creates visibly before navigation and advances generation', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => 10, () => new Uint8Array(16).fill(2))
    const opened = await host.open({ visible: true })
    expect((opened.page as FakePage).visible).toBe(true)
    expect((opened.page as FakePage).url).toBe('about:blank')
    const before = opened.status.generation
    await host.navigate(opened.status.id, 'https://example.test/a?secret=x', opened.status.pageIncarnation, before)
    expect((opened.page as FakePage).url).toBe('https://example.test/a?secret=x')
    expect(host.status(opened.status.id).generation).toBe(before + 1)
    expect(host.status(opened.status.id).safeRestoreUrl).toBe('https://example.test/a')
  })

  it('rejects stale mutations, including after physical user input', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    await expect(host.navigate(opened.status.id, 'https://example.test', 'stale', 0)).rejects.toThrow('STALE_GENERATION')
    userInputs.get(opened.status.id)!()
    await expect(host.navigate(opened.status.id, 'https://example.test', opened.status.pageIncarnation, opened.status.generation)).rejects.toThrow('STALE_GENERATION')
  })

  it('does not choose the visible renderer as the LRU victim', async () => {
    let time = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++time)
    const visible = await host.open({ visible: true })
    for (let i = 0; i < 4; i++) await host.open({ visible: false })
    expect(host.status(visible.status.id).lifecycle).toBe('live')
  })

  it('freezes the eligible LRU fifth page and changes incarnation on thaw', async () => {
    let time = 0
    const host = new TabBrowserHost(emptyBrowserState(1), factory, () => ++time)
    const opened = []
    for (let i = 0; i < 5; i++) opened.push(await host.open({ visible: i === 4 }))
    expect(host.status(opened[0]!.status.id).lifecycle).toBe('frozen')
    const incarnation = host.status(opened[0]!.status.id).pageIncarnation
    await host.thaw(opened[0]!.status.id)
    expect(host.status(opened[0]!.status.id).pageIncarnation).not.toBe(incarnation)
  })

  it('tracks user navigation, loading, and title events as host state', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    const event = pageEvents.get(opened.status.id)!
    event({ type: 'navigation-started' })
    expect(host.status(opened.status.id).loading).toBe(true)
    expect(host.status(opened.status.id).generation).toBe(1)
    event({ type: 'navigation-committed', url: 'https://example.test/path?secret=yes' })
    event({ type: 'title', title: 'A title' })
    expect(host.status(opened.status.id)).toMatchObject({ loading: false, safeRestoreUrl: 'https://example.test/path', title: 'A title' })
  })

  it('cancels a navigation by stopping the page load', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), {
      create: (_id, _input, _event) => {
        const page = new FakePage()
        page.loadURL = async () => new Promise<void>(() => {})
        return page
      },
    })
    const opened = await host.open({ visible: true })
    const controller = new AbortController()
    const navigation = host.navigate(opened.status.id, 'https://example.test', opened.status.pageIncarnation, opened.status.generation, controller.signal)
    controller.abort()
    await expect(navigation).rejects.toThrow('ACTION_CANCELLED')
    expect((opened.page as FakePage).stopped).toBe(true)
  })

  it('stops an active page load without closing the browser', async () => {
    const host = new TabBrowserHost(emptyBrowserState(1), factory)
    const opened = await host.open({ visible: true })
    host.stop(opened.status.id)
    expect((opened.page as FakePage).stopped).toBe(true)
    expect(host.status(opened.status.id).lifecycle).toBe('live')
  })
})
