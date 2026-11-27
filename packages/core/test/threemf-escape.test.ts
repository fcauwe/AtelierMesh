import { describe, expect, it } from 'vitest'
import { read3mf, write3mf, xmlUnescape } from '../src'
import { boxMesh } from '../src/testing'

describe('text that 3MF files escape', () => {
  it('xmlUnescape reads the named and the numeric entities in one pass', () => {
    expect(xmlUnescape('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;')).toBe('a & b <c> "d" \'e\' AB')
    expect(xmlUnescape('&amp;lt;')).toBe('&lt;')
    expect(xmlUnescape('&bogus; &#0; &#xD800; &amp')).toBe('&bogus; &#0; &#xD800; &amp')
    expect(xmlUnescape('plain')).toBe('plain')
  })
  it('metadata comes back as it was written, also JSON with quotes', async () => {
    const json = JSON.stringify({ slots: [{ id: '1', name: 'Part & "base" <1>' }] })
    const r = await read3mf(write3mf(boxMesh(10, 10, 10), { title: 'A & B', metadata: { colour_map: json, note: 'x < y' } }).bytes)
    expect(r.metadata['am:colour_map']).toBe(json)
    expect(JSON.parse(r.metadata['am:colour_map'] as string).slots[0].name).toBe('Part & "base" <1>')
    expect(r.metadata['am:note']).toBe('x < y')
    expect(r.metadata['Title']).toBe('A & B')
  })
  it('the name of a body with special characters comes back as it was', async () => {
    const m = boxMesh(10, 10, 10)
    const n = m.indices.length / 3
    const r = await read3mf(write3mf({ ...m, groups: [{ name: 'Lid & "knob"', role: 'solid', start: 0, count: n / 2 }, { name: 'Base <2>', role: 'solid', start: n / 2, count: n / 2 }] }).bytes)
    expect((r.mesh.groups ?? []).map(g => g.name)).toEqual(['Lid & "knob"', 'Base <2>'])
  })
})
