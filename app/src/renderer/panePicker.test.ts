import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PanePickerDialog } from './ProductivityDialogs'
import { panePickerDetail, renamePanePickerEntry, shouldDismissPanePicker } from './panePicker'
import { clearZoomForDestination } from './navigation'
import { filterPalette, type PaletteEntry } from './commandPalette'

describe('panePickerDetail', () => {
  it('puts workspace and tab labels in the displayed/searchable breadcrumb', () => {
    const detail = panePickerDetail('Platform', 'Release', 'shell', '/tmp/project', 'amber-1-2-0-a')
    expect(detail).toBe('Platform / Release · shell · /tmp/project · amber-1-2-0-a')
    expect(filterPalette([{ id: 'pane:a', label: 'Build', detail, keywords: 'a', run: vi.fn() }], 'release')).toHaveLength(1)
  })
})

describe('clearZoomForDestination', () => {
  it('clears only the destination tab zoom before picker navigation', () => {
    expect(clearZoomForDestination({ '1:1': 'a', '2:1': 'b' }, '2:1')).toEqual({ '1:1': 'a' })
    expect(clearZoomForDestination({ '1:1': 'a' }, '2:1')).toEqual({ '1:1': 'a' })
  })
})

describe('shouldDismissPanePicker', () => {
  it('dismisses on Escape even when a result row owns focus', () => {
    expect(shouldDismissPanePicker('Escape', true)).toBe(true)
    expect(shouldDismissPanePicker('Enter', true)).toBe(false)
    expect(shouldDismissPanePicker('Escape', false)).toBe(false)
  })
})

describe('renamePanePickerEntry', () => {
  it('closes and renames without invoking the navigation action', () => {
    const close = vi.fn()
    const run = vi.fn()
    const rename = vi.fn()
    renamePanePickerEntry({ id: 'pane:a', label: 'A', detail: '', keywords: '', run, rename }, close)
    expect(close).toHaveBeenCalledOnce()
    expect(rename).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('PanePickerDialog', () => {
  it('shows searchable workspace/tab breadcrumbs and a row-level rename action', () => {
    const rename = vi.fn()
    const entries = [{
      id: 'pane:amber-1-2-0-a',
      label: 'Build monitor',
      detail: 'Platform / Release · shell · /tmp/project · amber-1-2-0-a',
      keywords: 'amber-1-2-0-a platform release',
      run: vi.fn(),
      rename,
    }] as PaletteEntry[]
    const html = renderToStaticMarkup(createElement(PanePickerDialog, { entries, onClose: vi.fn() }))
    expect(html).toContain('Platform / Release')
    expect(html).toContain('Rename')
  })
})
