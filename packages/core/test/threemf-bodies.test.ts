import { describe, expect, it } from 'vitest'
import { MeshError, read3mf, selectPart, write3mf } from '../src'
import type { Mesh } from '../src'

// two unit boxes side by side as two bodies
const box = (x0: number): { p: number[]; t: number[] } => {
  const p: number[] = []
  for (const x of [x0, x0 + 1]) for (const y of [0, 1]) for (const z of [0, 1]) p.push(x, y, z)
  // vertex order: (x,y,z) -> 4*ix + 2*iy + iz
  const f = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
  const t: number[] = []
  for (const q of f) t.push(q[0] as number, q[1] as number, q[2] as number, q[0] as number, q[2] as number, q[3] as number)
  return { p, t }
}
const two = (): Mesh => {
  const a = box(0), b = box(3)
  const nv = a.p.length / 3
  return {
    positions: Float64Array.from([...a.p, ...b.p]), indices: Uint32Array.from([...a.t, ...b.t.map(v => v + nv)]),
    groups: [{ start: 0, count: 12, role: 'solid', name: 'Lid' }, { start: 12, count: 12, role: 'solid', name: 'Base' }],
  }
}

describe('3MF objects become bodies', () => {
  it('keeps the objects of a file as named bodies (write, read)', async () => {
    const bytes = write3mf(two(), { slicer: 'none' }).bytes
    const r = await read3mf(bytes)
    expect(r.objects).toBe(2)
    expect(r.mesh.groups?.map(g => [g.name, g.start, g.count, g.role])).toEqual([['Lid', 0, 12, 'solid'], ['Base', 12, 12, 'solid']])
  })
  it('a file with one object has no groups', async () => {
    const one = two(); one.indices = one.indices.slice(0, 36); one.positions = one.positions.slice(0, 24); delete one.groups
    const r = await read3mf(write3mf(one, { slicer: 'none' }).bytes)
    expect(r.mesh.groups).toBeUndefined()
  })
  it('gives equal names a number', async () => {
    const m = two(); m.groups = [{ start: 0, count: 12, role: 'solid', name: 'Part' }, { start: 12, count: 12, role: 'solid', name: 'Part' }]
    const r = await read3mf(write3mf(m, { slicer: 'none' }).bytes)
    expect(r.mesh.groups?.map(g => g.name)).toEqual(['Part', 'Part 2'])
  })
})

describe('choosing the default surface by name', () => {
  it('"body" is a part you can pick (every triangle that no segment was given), and an unknown name still fails', () => {
    const m = two(); delete m.groups
    const sel = selectPart(m, 'body', ['segment'])
    expect(sel && sel.every(x => x === 1)).toBe(true)
    expect(() => selectPart(m, 'nothing', ['segment', 'group'])).toThrow(MeshError)
  })
})
