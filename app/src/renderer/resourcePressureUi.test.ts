import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ParkedOverlay, ResourcePressureBanner } from './PressureBanners'
import { shouldResumeParkedPane } from './store'

describe('resource-pressure renderer UI', () => {
  it('renders every critical pressure cause in the banner', () => {
    const html = renderToStaticMarkup(createElement(ResourcePressureBanner, {
      pressure: { level: 'critical', causes: ['cpu', 'io'], blocked: false },
    }))
    expect(html).toContain('Amber CPU and I/O pressure is critical. Idle agent panes may be parked.')
    expect(html).toContain('role="alert"')
  })

  it('renders exact resource and legacy parked overlay copy', () => {
    const resource = renderToStaticMarkup(createElement(ParkedOverlay, {
      text: 'Parked to protect system resources', active: true, onResume: () => {},
    }))
    const legacy = renderToStaticMarkup(createElement(ParkedOverlay, {
      text: 'Parked to protect system memory', active: true, onResume: () => {},
    }))
    expect(resource).toContain('Parked to protect system resources')
    expect(legacy).toContain('Parked to protect system memory')
  })

  it('allows a parked pane to resume only from a trusted interaction in the active tab', () => {
    expect(shouldResumeParkedPane(true, true)).toBe(true)
    expect(shouldResumeParkedPane(true, false)).toBe(false)
    expect(shouldResumeParkedPane(false, true)).toBe(false)
  })
})
