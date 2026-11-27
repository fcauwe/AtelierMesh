import { describe, expect, it } from 'vitest'
import type { Mesh } from '@ateliermesh/core'
import { BODY_COLOR, triangleColors } from '../src/colors'

const mesh = (): Mesh => ({
  positions: new Float64Array(12), indices: Uint32Array.from(Array.from({ length: 12 }, (_, i) => i % 4)),   // 4 triangles
  groups: [{ start: 0, count: 2, role: 'solid', name: 'A', color: '#112233' }, { start: 2, count: 2, role: 'solid', name: 'B' }],
  segments: { labels: Uint16Array.from([0, 1, 0, 1]), table: [{ id: 0, name: 'body' }, { id: 1, name: 'mark', color: '#ff0000' }] },
})
const of = (m: Mesh): string[] => { const { palette, index } = triangleColors(m); return Array.from(index, i => palette[i] as string) }

describe('the colour of every triangle in the 3D view', () => {
  it('a segment colour wins over the body colour; a body colour shows on the default segment; no colour is the body grey', () => {
    expect(of(mesh())).toEqual(['#112233', '#ff0000', BODY_COLOR, '#ff0000'])
  })
  it('the default segment can carry a colour of its own, under the body colour', () => {
    const m = mesh(); m.segments!.table[0]!.color = '#00ff00'
    expect(of(m)).toEqual(['#112233', '#ff0000', '#00ff00', '#ff0000'])
  })
  it('a mesh with neither groups nor segments is one grey', () => {
    expect(of({ positions: new Float64Array(9), indices: Uint32Array.from([0, 1, 2]) })).toEqual([BODY_COLOR])
  })
})
