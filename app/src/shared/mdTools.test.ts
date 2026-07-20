import { describe, it, expect } from 'vitest'
import {
  mdOutline,
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  wrapLink,
  toggleList,
  toggleTaskCheckbox,
  formatTable,
  type MdEdit,
} from './mdTools'

describe('mdOutline', () => {
  it('collects ATX headings with 1-based line numbers', () => {
    const text = '# One\n\ntext\n### Three\n'
    expect(mdOutline(text)).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 3, text: 'Three', line: 4 },
    ])
  })
  it('strips closing hashes and trims', () => {
    expect(mdOutline('##  Two  ##')).toEqual([{ level: 2, text: 'Two', line: 1 }])
  })
  it('collects setext headings', () => {
    expect(mdOutline('Title\n=====\n\nSub\n---\n')).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Sub', line: 4 },
    ])
  })
  it('ignores headings inside fenced code blocks', () => {
    const text = '# Real\n\n```sh\n# not a heading\n```\n\n~~~\n## also not\n~~~\n\n## Real 2\n'
    expect(mdOutline(text)).toEqual([
      { level: 1, text: 'Real', line: 1 },
      { level: 2, text: 'Real 2', line: 11 },
    ])
  })
  it('ignores a bare --- rule and #hashtags', () => {
    expect(mdOutline('\n---\n\n#tag\n')).toEqual([])
  })
  it('ignores more than six hashes', () => {
    expect(mdOutline('####### nope')).toEqual([])
  })
})

// Round-trip helper: apply `f`, then apply it again to the result using the
// returned selection — a true toggle lands back on the original text+selection.
function roundTrip(f: (t: string, a: number, b: number) => MdEdit, text: string, from: number, to: number): void {
  const once = f(text, from, to)
  expect(once.text).not.toBe(text)
  const twice = f(once.text, once.from, once.to)
  expect(twice).toEqual({ text, from, to })
}

describe('toggleBold', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(toggleBold('hello world', 6, 11)).toEqual({ text: 'hello **world**', from: 8, to: 13 })
  })
  it('unwraps markers surrounding the selection', () => {
    expect(toggleBold('hello **world**', 8, 13)).toEqual({ text: 'hello world', from: 6, to: 11 })
  })
  it('unwraps markers inside the selection', () => {
    expect(toggleBold('hello **world**', 6, 15)).toEqual({ text: 'hello world', from: 6, to: 11 })
  })
  it('round-trips', () => roundTrip(toggleBold, 'hello world', 6, 11))
  it('round-trips an empty selection (cursor lands between the markers)', () => {
    expect(toggleBold('ab', 1, 1)).toEqual({ text: 'a****b', from: 3, to: 3 })
    roundTrip(toggleBold, 'ab', 1, 1)
  })
})

describe('toggleItalic', () => {
  it('wraps with a single star', () => {
    expect(toggleItalic('hello world', 6, 11)).toEqual({ text: 'hello *world*', from: 7, to: 12 })
  })
  it('round-trips', () => roundTrip(toggleItalic, 'hello world', 6, 11))
  it('does not mistake bold markers for italic ones', () => {
    expect(toggleItalic('**word**', 2, 6)).toEqual({ text: '***word***', from: 3, to: 7 })
  })
})

describe('toggleInlineCode', () => {
  it('wraps with backticks', () => {
    expect(toggleInlineCode('run x now', 4, 5)).toEqual({ text: 'run `x` now', from: 5, to: 6 })
  })
  it('round-trips', () => roundTrip(toggleInlineCode, 'run x now', 4, 5))
})

describe('wrapLink', () => {
  it('wraps the selection and selects the empty url slot', () => {
    const r = wrapLink('see docs', 4, 8)
    expect(r.text).toBe('see [docs]()')
    expect(r.text.slice(r.from, r.to)).toBe('')
    expect(r.from).toBe(11)
  })
  it('inserts a given url and selects it', () => {
    const r = wrapLink('see docs', 4, 8, 'https://x.dev')
    expect(r.text).toBe('see [docs](https://x.dev)')
    expect(r.text.slice(r.from, r.to)).toBe('https://x.dev')
  })
  it('an empty selection produces an empty link text slot', () => {
    const r = wrapLink('', 0, 0, 'u')
    expect(r.text).toBe('[](u)')
    expect(r.from).toBe(1)
    expect(r.to).toBe(1)
  })
})

describe('toggleList', () => {
  it('adds a bullet marker to each line in the selection', () => {
    const r = toggleList('a\nb\n', 0, 3, '-')
    expect(r.text).toBe('- a\n- b\n')
  })
  it('removes bullets when every line already has one', () => {
    expect(toggleList('- a\n- b', 0, 7, '-').text).toBe('a\nb')
  })
  it('numbers lines for the 1. marker', () => {
    expect(toggleList('a\nb\nc', 0, 5, '1.').text).toBe('1. a\n2. b\n3. c')
  })
  it('renumbers away cleanly', () => {
    expect(toggleList('1. a\n2. b', 0, 9, '1.').text).toBe('a\nb')
  })
  it('preserves indentation', () => {
    expect(toggleList('  a', 0, 3, '-').text).toBe('  - a')
  })
  it('expands a partial selection to whole lines', () => {
    const r = toggleList('abc\ndef', 1, 5, '-')
    expect(r.text).toBe('- abc\n- def')
    expect(r.from).toBe(0)
    expect(r.to).toBe(r.text.length)
  })
  it('round-trips (bullets)', () => roundTrip((t, a, b) => toggleList(t, a, b, '-'), '- a\n- b', 0, 7))
  it('round-trips (numbers)', () => roundTrip((t, a, b) => toggleList(t, a, b, '1.'), '1. a\n2. b', 0, 9))
})

describe('toggleTaskCheckbox', () => {
  it('checks unchecked items', () => {
    expect(toggleTaskCheckbox('- [ ] a\n- [ ] b', 0, 15).text).toBe('- [x] a\n- [x] b')
  })
  it('unchecks when every item is checked', () => {
    expect(toggleTaskCheckbox('- [x] a\n- [X] b', 0, 15).text).toBe('- [ ] a\n- [ ] b')
  })
  it('checks all when the state is mixed', () => {
    expect(toggleTaskCheckbox('- [ ] a\n- [x] b', 0, 15).text).toBe('- [x] a\n- [x] b')
  })
  it('adds a checkbox to a plain list item', () => {
    expect(toggleTaskCheckbox('- a', 0, 3).text).toBe('- [ ] a')
  })
  it('adds a full task marker to a plain line', () => {
    expect(toggleTaskCheckbox('a', 0, 1).text).toBe('- [ ] a')
  })
  it('round-trips the checked state', () => roundTrip(toggleTaskCheckbox, '- [ ] a\n- [ ] b', 0, 15))
})

describe('formatTable', () => {
  it('aligns pipes across the table containing the selection', () => {
    const text = '| a | long header |\n|---|---|\n| 1 | 2 |'
    const r = formatTable(text, 0, 1)
    expect(r.text).toBe('| a   | long header |\n| --- | ----------- |\n| 1   | 2           |')
    expect(r.from).toBe(0)
    expect(r.to).toBe(r.text.length)
  })
  it('keeps alignment markers', () => {
    const text = '|a|b|c|\n|:--|--:|:-:|\n|1|2|3|'
    expect(formatTable(text, 0, 1).text).toBe('| a   | b   | c   |\n| :-- | --: | :-: |\n| 1   | 2   | 3   |')
  })
  it('formats only the table block around the cursor', () => {
    const text = 'intro\n\n|a|b|\n|-|-|\n|1|2|\n\nafter'
    const r = formatTable(text, 8, 8)
    expect(r.text).toBe('intro\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nafter')
  })
  it('is a no-op when the selection is not in a table', () => {
    expect(formatTable('no table here', 2, 3)).toEqual({ text: 'no table here', from: 2, to: 3 })
  })
})
