import { describe, expect, it } from 'vitest'
import {
  BROWSER_VIEWPORT_PRESETS,
  clampRailWidth,
  formatLastPiAction,
  keyboardRailWidth,
  railReloadCommand,
  reclampedRailWidth,
  railStopCommand,
  railWidthMetrics,
  railSecurity,
  railStatusLines,
  secondsRemaining,
  shouldOccludeBrowser,
  validateCustomViewport,
} from './browserRailModel'

describe('browser rail approval/action presentation', () => {
  it('counts a 60 second approval down live without going negative', () => {
    expect(secondsRemaining(61_000, 1_000)).toBe(60)
    expect(secondsRemaining(61_000, 60_100)).toBe(1)
    expect(secondsRemaining(61_000, 61_001)).toBe(0)
  })

  it('renders started, completed, and stable failed action summaries', () => {
    expect(formatLastPiAction({ action: 'click', phase: 'started' })).toBe('Pi click: started')
    expect(formatLastPiAction({ action: 'click', phase: 'completed' })).toBe('Pi click: completed')
    expect(formatLastPiAction({ action: 'click', phase: 'failed', error: 'TARGET_OCCLUDED' })).toBe('Pi click: failed (TARGET_OCCLUDED)')
  })
})

describe('browser rail product state', () => {
  it('uses one rendered width calculation for style, pointer, keyboard, and ARIA', () => {
    expect(railWidthMetrics(900, 800)).toEqual({ min: 280, max: 560, width: 560 })
    expect(railWidthMetrics(50, 1200)).toEqual({ min: 280, max: 900, width: 280 })
    expect(railWidthMetrics(5000, 1200)).toEqual({ min: 280, max: 900, width: 900 })
    expect(reclampedRailWidth(900, 800)).toBe(560)
    expect(reclampedRailWidth(560, 800)).toBeNull()
  })

  it('builds parser-compatible stop and live/frozen reload commands', () => {
    const live = { id: 'browser-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pageIncarnation: 'page-a', generation: 4, lifecycle: 'live' as const }
    expect(railStopCommand(live)).toEqual({ type: 'stop', id: live.id, pageIncarnation: 'page-a', expectedGeneration: 4 })
    expect(railReloadCommand(live, { x: 1, y: 2, width: 300, height: 400 })).toEqual({ type: 'reload', id: live.id, pageIncarnation: 'page-a', expectedGeneration: 4 })
    expect(railReloadCommand({ ...live, lifecycle: 'frozen' }, { x: 1, y: 2, width: 300, height: 400 })).toEqual({ type: 'show', id: live.id, bounds: { x: 1, y: 2, width: 300, height: 400 } })
  })

  it('clamps pointer and keyboard resizing while preserving terminal space', () => {
    expect(clampRailWidth(50, 1200)).toBe(280)
    expect(clampRailWidth(2000, 1200)).toBe(900)
    expect(clampRailWidth(900, 800)).toBe(560)
    expect(keyboardRailWidth(420, 'ArrowLeft', 1200)).toBe(440)
    expect(keyboardRailWidth(420, 'ArrowRight', 1200)).toBe(400)
    expect(keyboardRailWidth(420, 'Home', 1200)).toBe(280)
    expect(keyboardRailWidth(420, 'End', 800)).toBe(560)
    expect(keyboardRailWidth(420, 'Escape', 1200)).toBeNull()
  })

  it('labels user-only current URL security without exposing it in action status', () => {
    expect(railSecurity('https://example.test/private?token=x')).toEqual({ level: 'secure', label: 'Secure HTTPS' })
    expect(railSecurity('http://localhost:3000')).toEqual({ level: 'local', label: 'Local HTTP' })
    expect(railSecurity('http://example.test')).toEqual({ level: 'insecure', label: 'Not secure' })
    expect(railSecurity('about:blank')).toEqual({ level: 'neutral', label: 'Blank page' })
  })

  it('provides fixed presets and validates bounded custom viewports', () => {
    expect(BROWSER_VIEWPORT_PRESETS.map((preset) => preset.id)).toEqual(['responsive', 'desktop', 'tablet', 'mobile'])
    expect(validateCustomViewport('1440', '900')).toEqual({ width: 1440, height: 900 })
    expect(validateCustomViewport('199', '900')).toBeNull()
    expect(validateCustomViewport('1440.5', '900')).toBeNull()
    expect(validateCustomViewport('5000', '900')).toBeNull()
  })

  it('projects loading, capacity, frozen, restore, diagnostics, sharing, and focus states', () => {
    expect(railStatusLines({ lifecycle: 'frozen', loading: false, capacityWaiting: true, restoredAfterFreeze: false,
      restoreError: 'Page crashed', focused: false, diagnostics: { consoleIssues: 2, networkFailures: 1 }, sharedWithPi: true })).toEqual([
      'Frozen · reload to continue', 'Waiting for browser capacity', 'Restore issue: Page crashed',
      'Console issues: 2', 'Network failures: 1', 'Shared with Pi',
    ])
    expect(railStatusLines({ lifecycle: 'live', loading: true, capacityWaiting: false, restoredAfterFreeze: true,
      focused: true, diagnostics: { consoleIssues: 0, networkFailures: 0 }, sharedWithPi: false })).toEqual([
      'Loading', 'Reloaded after background freeze', 'Browser page focused',
    ])
  })

  it('occludes native content for external UI and terminal zoom, not ordinary chrome', () => {
    expect(shouldOccludeBrowser({ externalOverlay: true, externalMenu: false, terminalZoom: false })).toBe(true)
    expect(shouldOccludeBrowser({ externalOverlay: false, externalMenu: true, terminalZoom: false })).toBe(true)
    expect(shouldOccludeBrowser({ externalOverlay: false, externalMenu: false, terminalZoom: true })).toBe(true)
    expect(shouldOccludeBrowser({ externalOverlay: false, externalMenu: false, terminalZoom: false })).toBe(false)
  })
})
