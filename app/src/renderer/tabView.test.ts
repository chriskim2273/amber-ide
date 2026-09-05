import { describe, it, expect } from 'vitest'
import { cleanOscTitle, deriveTab, shortCwd } from './tabView'
import { leaves } from './layout'
import type { PaneModel } from './store'

const pane = (over: Partial<PaneModel> & { name: string }): PaneModel => ({
  cwd: '/home/u/proj', kind: 'shell', alive: true, ord: 0, deadCode: null, ...over,
})

describe('shortCwd', () => {
  it('collapses $HOME to ~', () => {
    expect(shortCwd('/home/u/proj', '/home/u')).toBe('~/proj')
    expect(shortCwd('/etc', '/home/u')).toBe('/etc')
    expect(shortCwd('/anything', '')).toBe('/anything')
  })
})

describe('deriveTab', () => {
  const home = '/home/u'

  it('strips the Pi app-brand prefix and the duplicate cwd token from a Pi OSC title', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', kind: 'pi', cwd: '/home/u/proj' }), pane({ name: 'b', kind: 'pi', cwd: '/home/u/proj' })],
      null, {}, { a: 'π - refactor-auth - proj', b: 'Pi - refactor-auth - proj' }, home,
    )
    expect(paneMeta.a!.title).toBe('refactor-auth · pi')
    expect(paneMeta.b!.title).toBe('refactor-auth · pi')
  })

  it('renders a name-less Pi title (brand + cwd) as just the cwd basename', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', kind: 'pi', cwd: '/home/u/proj' })],
      null, {}, { a: 'π - proj' }, home,
    )
    expect(paneMeta.a!.title).toBe('proj · pi')
  })

  it('does not rewrite a non-Pi shell pane OSC title', () => {
    // Only Pi panes are rewritten; a shell keeps its own title verbatim.
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', kind: 'shell', cwd: '/home/u/proj' })],
      null, {}, { a: 'vim - README' }, home,
    )
    expect(paneMeta.a!.title).toBe('vim - README · shell')
  })

  it('does not strip a trailing dash token that is not the cwd basename (Pi)', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', kind: 'pi', cwd: '/home/u/proj' })],
      null, {}, { a: 'π - my-session - README' }, home,
    )
    expect(paneMeta.a!.title).toBe('my-session - README · pi')
  })

  it('empty/blank agent title falls back to shortCwd and keeps the brand intact nowhere', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', kind: 'pi', cwd: '/home/u/proj' })],
      null, {}, { a: '   ' }, home,
    )
    expect(paneMeta.a!.title).toBe('~/proj · pi')
  })

  it('preserves a valid U+FEFF friendly title instead of treating it as blank', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', title: '\uFEFFBuild\uFEFF', cwd: '/home/u/proj' })],
      null, {}, {}, home,
    )
    expect(paneMeta.a!.title).toBe('\uFEFFBuild\uFEFF · shell')
  })

  it('lets a durable friendly title outrank OSC and cwd fallbacks', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', title: '  Release checklist  ', cwd: '/home/u/proj' }),
       pane({ name: 'b', title: 'Build logs', cwd: '/home/u/x' })],
      null, {}, { 'a': 'vim', 'b': 'shell' }, home,
    )
    expect(paneMeta.a!.title).toBe('Release checklist · shell')
    expect(paneMeta.b!.title).toBe('Build logs · shell')
  })

  it('titles a pane from its OSC title when present, else the short cwd', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'a', cwd: '/home/u/proj' }), pane({ name: 'b', cwd: '/home/u/x' })],
      null, {}, { a: 'vim' }, home,
    )
    expect(paneMeta.a!.title).toBe('vim · shell')      // OSC title wins
    expect(paneMeta.b!.title).toBe('~/x · shell')      // falls back to shortCwd
  })

  it('falls back to cwd when the OSC title is blank/whitespace', () => {
    const { paneMeta } = deriveTab([pane({ name: 'a', cwd: '/home/u/z' })], null, {}, { a: '  ' }, home)
    expect(paneMeta.a!.title).toBe('~/z · shell')
  })

  it('labels a shell-fallback claude pane distinctly', () => {
    const { paneMeta } = deriveTab(
      [pane({ name: 'c', kind: 'claude', runState: 'shell-fallback', cwd: '/home/u' })],
      null, {}, {}, home,
    )
    expect(paneMeta.c!.title).toBe('~ · shell (claude exited)')
  })

  it('records deadCodes only for exited panes', () => {
    const { deadCodes } = deriveTab(
      [pane({ name: 'a' }), pane({ name: 'b', deadCode: 130 }), pane({ name: 'c', deadCode: 0 })],
      null, {}, {}, home,
    )
    expect(deadCodes).toEqual({ b: 130, c: 0 })   // note: code 0 IS recorded (not null)
  })

  it('holds pending-split names out of liveIds and the reconciled tree', () => {
    const { liveIds, tree } = deriveTab(
      [pane({ name: 'a' }), pane({ name: 'pending-1' })],
      null, { 'pending-1': { paneId: 'a', dir: 'h' } }, {}, home,
    )
    expect(liveIds).toEqual(['a'])
    expect(leaves(tree)).toEqual(['a'])            // pending pane not appended
  })

  it('reconciles the stored tree down to the live pane set', () => {
    const stored = { kind: 'leaf', paneId: 'a' } as const
    // 'a' persists; 'b' is new -> appended; there is no dead leaf to prune here.
    const { tree } = deriveTab([pane({ name: 'a' }), pane({ name: 'b' })], stored, {}, {}, home)
    expect(new Set(leaves(tree))).toEqual(new Set(['a', 'b']))
  })

  it('yields a null tree for an empty tab', () => {
    expect(deriveTab([], null, {}, {}, home).tree).toBeNull()
  })
})

// The pane header leads with the `amber ls` index so the user can jump to it
// with `amber attach <n>` from any terminal.
describe('deriveTab slot prefix', () => {
  it('prefixes the daemon pane title with its stable slot', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-1-1-0-x', slot: 3 })], null, {}, {}, '/home/u')
    expect(paneMeta['amber-1-1-0-x']!.title).toBe('#3 ~/proj · shell')
  })
  it('keeps an OSC title but still leads with the slot', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-1-1-1-y', slot: 7 })], null,
      {}, { 'amber-1-1-1-y': 'vim README' }, '/home/u')
    expect(paneMeta['amber-1-1-1-y']!.title).toBe('#7 vim README · shell')
  })
  it('gives an app-local pane no slot (it has no daemon session)', () => {
    const { paneMeta } = deriveTab([pane({ name: 'editor-1-1-0-z', kind: 'editor', cwd: '' })],
      null, {}, {}, '/home/u')
    expect(paneMeta['editor-1-1-0-z']!.title).toBe('untitled · editor')
  })
  it('omits the prefix when the daemon reports no slot (older daemon) rather than inventing one', () => {
    const { paneMeta } = deriveTab([pane({ name: 'amber-9-9-9-new' })], null, {}, {}, '/home/u')
    expect(paneMeta['amber-9-9-9-new']!.title).toBe('~/proj · shell')
    const zero = deriveTab([pane({ name: 'amber-9-9-9-zero', slot: 0 })], null, {}, {}, '/home/u')
    expect(zero.paneMeta['amber-9-9-9-zero']!.title).toBe('~/proj · shell')
  })
})
