import { describe, expect, it } from 'vitest'
import { TabBrowserHost, type TabBrowserPage, type TabBrowserPageFactory } from './tabBrowserHost'
import { emptyBrowserState } from '../shared/tabBrowserState'

class FakePage implements TabBrowserPage {
  url = 'about:blank'; destroyed = false; visible = false
  async loadURL(url: string) { this.url = url }
  show() { this.visible = true }
  hide() { this.visible = false }
  destroy() { this.destroyed = true }
}

const userInputs = new Map<string, () => void>()
const factory: TabBrowserPageFactory = { create: (id, onUserInput) => { userInputs.set(id, onUserInput); return new FakePage() } }

describe('TabBrowserHost', () => {
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
})
