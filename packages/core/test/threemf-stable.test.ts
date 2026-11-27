import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { write3mf } from '../src'
import type { Mesh, SlicerColours } from '../src'

// The 3MF bytes for every colour option, as they were when the options still carried product names (taken before the rename). They must not change:
// a file we wrote yesterday and a file we write today are the same bytes. (A change on purpose means updating these hashes and saying why in CHANGELOG.md.)
const box = (x0: number): { p: number[]; t: number[] } => {
  const p: number[] = []
  for (const x of [x0, x0 + 1]) for (const y of [0, 1]) for (const z of [0, 1]) p.push(x, y, z)
  const f = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
  const t: number[] = []
  for (const q of f) t.push(q[0] as number, q[1] as number, q[2] as number, q[0] as number, q[2] as number, q[3] as number)
  return { p, t }
}
const a = box(0), b = box(3), nv = a.p.length / 3
const labels = new Uint16Array(24); for (let i = 0; i < 24; i++) labels[i] = i % 5 === 0 ? 1 : i % 7 === 0 ? 2 : 0
const mesh: Mesh = {
  positions: Float64Array.from([...a.p, ...b.p]), indices: Uint32Array.from([...a.t, ...b.t.map(v => v + nv)]),
  groups: [{ start: 0, count: 12, role: 'solid', name: 'Lid' }, { start: 12, count: 12, role: 'solid', name: 'Base' }],
  segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'letters', color: '#e5484d' }, { id: 2, name: 'letter_walls', color: '#30a46c' }] },
}
const palette = [{ segment: 'letters', extruder: 2 }, { segment: 'letter_walls', color: '#112233', extruder: 3 }]
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const EXPECTED: Record<string, string> = {
  default: '1e2145c54b5248fce55aa787f8df14e7730708f142aa31f09e2c73622fb13a7f',
  inline_sidecar: '1e2145c54b5248fce55aa787f8df14e7730708f142aa31f09e2c73622fb13a7f',
  inline: 'f946d001f0f672301abb9676ba9c1c8530f3585ad9a6c547328c3170565908a1',
  sidecar: 'f90d66ce9a0bde0948f1a454dcabc03bb5c27ee9d4608dd714baf562bfc14c81',
  alt_inline: '206cf15e7044a501d865f3809da2f6f40e1bf92f70757fd3f673620eb10ecdea',
  all: 'adc9feb42e89006357851e7c7765bed1d733c2ca6afb70ec1c56925ff7bea1a7',
  none: '90554969945f556fca63445d24b324ac1c4876624e0ce03bb46e45e302062df0',
  plain: '46c4841d28dfa0f53298ddedc28f3cca5dea6269593a8bdd72d4e8927327a5e5',
}

describe('the 3MF bytes of every colour option do not change', () => {
  for (const name of ['default', 'inline_sidecar', 'inline', 'sidecar', 'alt_inline', 'all', 'none']) {
    it(name, () => {
      const r = write3mf(mesh, { palette, groupExtruders: { Lid: 1, Base: 2 }, ...(name === 'default' ? {} : { slicer: name as SlicerColours }) })
      expect(sha(r.bytes)).toBe(EXPECTED[name])
    })
  }
  it('a part without colours', () => {
    expect(sha(write3mf({ ...mesh, segments: undefined, groups: undefined } as Mesh).bytes)).toBe(EXPECTED['plain'])
  })
})
