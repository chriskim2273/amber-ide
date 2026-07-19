import { describe, it, expect } from 'vitest'
import { jsonErrorAt, formatJson, minifyJson, sortJsonKeys, buildJsonTree, jsonNodeOffset } from './jsonTools'

// Helper: the real SyntaxError for a text (these tools only ever see real ones).
function errFor(text: string): unknown {
  try {
    JSON.parse(text)
    throw new Error('expected a parse error')
  } catch (e) {
    return e
  }
}

describe('jsonErrorAt', () => {
  it('locates a mid-document error (1-based line/col)', () => {
    const text = '{\n  "a": 1,\n}'
    const at = jsonErrorAt(text, errFor(text))
    expect(at.line).toBe(3)
    expect(at.col).toBe(1)
    expect(text.slice(at.from, at.to)).toBe('}')
  })
  it('handles an empty document (no position in the message)', () => {
    const at = jsonErrorAt('', errFor(''))
    expect(at).toEqual({ line: 1, col: 1, from: 0, to: 0 })
  })
  it('handles an error on the last line', () => {
    const text = '{"a": 1,'
    const at = jsonErrorAt(text, errFor(text))
    expect(at.line).toBe(1)
    expect(at.from).toBeLessThanOrEqual(text.length)
    expect(at.to).toBeLessThanOrEqual(text.length)
    expect(at.from).toBeLessThanOrEqual(at.to)
  })
  it('handles a trailing comma', () => {
    const text = '{"a": 1,}'
    const at = jsonErrorAt(text, errFor(text))
    expect(at.line).toBe(1)
    expect(text.slice(at.from, at.to)).toBe('}')
  })
  it('handles an unterminated string', () => {
    const text = '{\n"a": "foo\n}'
    const at = jsonErrorAt(text, errFor(text))
    expect(at.from).toBeGreaterThan(0)
    expect(at.from).toBeLessThanOrEqual(text.length)
    expect(at.line).toBeGreaterThanOrEqual(1)
  })
  it('falls back to offset 0 when the message carries no position', () => {
    const text = 'abc'
    const at = jsonErrorAt(text, errFor(text))
    expect(at).toEqual({ line: 1, col: 1, from: 0, to: 1 })
  })
  it('never throws on a non-Error argument', () => {
    expect(jsonErrorAt('x', 'not an error')).toEqual({ line: 1, col: 1, from: 0, to: 1 })
    expect(jsonErrorAt('', null)).toEqual({ line: 1, col: 1, from: 0, to: 0 })
  })
  it('clamps an out-of-range position', () => {
    const at = jsonErrorAt('ab', new SyntaxError('boom in JSON at position 999'))
    expect(at.from).toBe(2)
    expect(at.to).toBe(2)
  })
})

describe('formatJson / minifyJson', () => {
  it('formats with the given indent', () => {
    expect(formatJson('{"a":[1,2]}', 2)).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ]\n}' })
  })
  it('defaults to indent 2', () => {
    expect(formatJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}' })
  })
  it('minifies', () => {
    expect(minifyJson('{\n  "a": [ 1, 2 ]\n}')).toEqual({ text: '{"a":[1,2]}' })
  })
  it('returns an error instead of throwing', () => {
    const r = formatJson('{')
    expect('error' in r && typeof r.error === 'string').toBe(true)
    const m = minifyJson('nope')
    expect('error' in m && typeof m.error === 'string').toBe(true)
  })
})

describe('sortJsonKeys', () => {
  it('sorts recursively and leaves arrays in order', () => {
    const r = sortJsonKeys('{"b":1,"a":{"z":1,"y":[3,1,2]}}')
    expect(r).toEqual({ text: '{\n  "a": {\n    "y": [\n      3,\n      1,\n      2\n    ],\n    "z": 1\n  },\n  "b": 1\n}' })
  })
  it('sorts keys of objects inside arrays', () => {
    expect(sortJsonKeys('[{"b":1,"a":2}]', 0)).toEqual({ text: '[{"a":2,"b":1}]' })
  })
  it('errors instead of throwing', () => {
    expect('error' in sortJsonKeys('{')).toBe(true)
  })
})

describe('buildJsonTree', () => {
  it('builds nodes for an object root with JSONPath-ish paths', () => {
    const nodes = buildJsonTree({ a: { b: [1] }, s: 'hi' })
    expect(nodes.map((n) => n.path)).toEqual(['$.a', '$.s'])
    expect(nodes[0]!.kind).toBe('object')
    expect(nodes[0]!.children[0]!.path).toBe('$.a.b')
    expect(nodes[0]!.children[0]!.children[0]!.path).toBe('$.a.b[0]')
    expect(nodes[0]!.children[0]!.children[0]!.key).toBe('0')
    expect(nodes[1]!.kind).toBe('string')
    expect(nodes[1]!.preview).toBe('"hi"')
  })
  it('brackets keys that are not plain identifiers', () => {
    const nodes = buildJsonTree({ 'a b': 1, '2x': 2 })
    expect(nodes.map((n) => n.path)).toEqual(['$["a b"]', '$["2x"]'])
  })
  it('root array elements are indexed', () => {
    const nodes = buildJsonTree([1, null, true])
    expect(nodes.map((n) => n.path)).toEqual(['$[0]', '$[1]', '$[2]'])
    expect(nodes.map((n) => n.kind)).toEqual(['number', 'null', 'boolean'])
  })
  it('a scalar root is a single $ node', () => {
    const nodes = buildJsonTree(42)
    expect(nodes).toEqual([{ key: '$', path: '$', kind: 'number', preview: '42', children: [] }])
  })
  it('previews containers by size', () => {
    const nodes = buildJsonTree({ o: { a: 1, b: 2 }, arr: [1, 2, 3] })
    expect(nodes[0]!.preview).toBe('{2}')
    expect(nodes[1]!.preview).toBe('[3]')
  })
  it('truncates a long string preview', () => {
    const nodes = buildJsonTree({ s: 'x'.repeat(100) })
    expect(nodes[0]!.preview.length).toBeLessThan(50)
    expect(nodes[0]!.preview.endsWith('…')).toBe(true)
  })
})

describe('jsonNodeOffset', () => {
  const text = '{\n  "a": { "b": [10, 20] },\n  "c": "x"\n}'
  it('finds a top-level value', () => {
    expect(text.slice(jsonNodeOffset(text, '$.c'))).toMatch(/^"x"/)
  })
  it('finds a nested value regardless of whitespace', () => {
    expect(text.slice(jsonNodeOffset(text, '$.a.b'))).toMatch(/^\[10/)
    expect(text.slice(jsonNodeOffset(text, '$.a.b[1]'))).toMatch(/^20/)
  })
  it('finds the root', () => {
    expect(jsonNodeOffset(text, '$')).toBe(0)
  })
  it('handles duplicate keys the way JSON.parse does (last wins)', () => {
    const dup = '{"a": 1, "a": 2}'
    expect(dup.slice(jsonNodeOffset(dup, '$.a'))).toBe('2}')
  })
  it('is not fooled by a key name appearing inside a string value', () => {
    const t = '{"x": "\\"b\\": 99", "b": 7}'
    expect(t.slice(jsonNodeOffset(t, '$.b'))).toBe('7}')
  })
  it('handles bracketed paths', () => {
    const t = '{"a b": 5}'
    expect(t.slice(jsonNodeOffset(t, '$["a b"]'))).toBe('5}')
  })
  it('returns -1 for a missing path or invalid json', () => {
    expect(jsonNodeOffset(text, '$.nope')).toBe(-1)
    expect(jsonNodeOffset(text, 'garbage')).toBe(-1)
    expect(jsonNodeOffset('{', '$.a')).toBe(-1)
  })
})
