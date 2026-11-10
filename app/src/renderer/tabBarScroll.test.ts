import * as assert from 'node:assert/strict'
import { test } from 'vitest'
import { enableTabWheel } from './tabBarScroll'

class TabBar extends EventTarget {
  clientWidth = 200
  scrollWidth = 800
  #left = 0
  get scrollLeft(): number { return this.#left }
  set scrollLeft(value: number) { this.#left = Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth)) }
}

function wheel(init = {}): Event {
  return Object.assign(new Event('wheel', { cancelable: true }), {
    deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, ...init,
  })
}

test('vertical wheel scrolls overflowing tabs and cleans up its listener', () => {
  const bar = new TabBar()
  const dispose = enableTabWheel(bar as unknown as HTMLElement)
  const down = wheel({ deltaY: 80 })
  bar.dispatchEvent(down)
  assert.equal(bar.scrollLeft, 80)
  assert.equal(down.defaultPrevented, true)
  bar.dispatchEvent(wheel({ deltaY: -25 }))
  assert.equal(bar.scrollLeft, 55)
  dispose()
  bar.dispatchEvent(wheel({ deltaY: 80 }))
  assert.equal(bar.scrollLeft, 55)
})

test('preserves native horizontal scrolling, zoom, and boundary events', () => {
  const bar = new TabBar()
  enableTabWheel(bar as unknown as HTMLElement)
  for (const event of [wheel({ deltaX: 30, deltaY: 5 }), wheel({ deltaY: 30, ctrlKey: true }),
    wheel({ deltaY: 30, shiftKey: true }), wheel({ deltaY: -30 })]) {
    bar.dispatchEvent(event)
    assert.equal(event.defaultPrevented, false)
    assert.equal(bar.scrollLeft, 0)
  }
  bar.scrollWidth = bar.clientWidth
  const noOverflow = wheel({ deltaY: 30 })
  bar.dispatchEvent(noOverflow)
  assert.equal(noOverflow.defaultPrevented, false)
})

test('converts line and page wheel deltas into pixels', () => {
  const bar = new TabBar()
  enableTabWheel(bar as unknown as HTMLElement)
  bar.dispatchEvent(wheel({ deltaY: 2, deltaMode: 1 }))
  assert.equal(bar.scrollLeft, 32)
  bar.dispatchEvent(wheel({ deltaY: 1, deltaMode: 2 }))
  assert.equal(bar.scrollLeft, 232)
})
