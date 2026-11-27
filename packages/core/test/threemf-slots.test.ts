import { describe, expect, it } from 'vitest'
import { applyColourMap, read3mf, segmentTable, write3mf } from '../src'
import { readZip, writeZip } from '../src/zip'
import type { ColourMap, Mesh } from '../src'
import { boxMesh } from '../src/testing'

// A final 3MF of the Atelier: the colour slots must come back from the file alone (docs: a file AtelierMesh wrote keeps one segment per material, by name).
const three = (): { mesh: Mesh; map: ColourMap } => {
  const m = boxMesh(10, 10, 10)
  const n = m.indices.length / 3
  const labels = new Uint16Array(n); for (let i = 0; i < n; i++) labels[i] = i % 3
  return {
    mesh: { ...m, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'text' }, { id: 2, name: 'base' }] } },
    map: { slots: [{ id: '1', name: 'Part', parts: ['body'] }, { id: '2', name: 'Text', parts: ['text'] }, { id: '3', name: 'Base', parts: ['base'] }] },
  }
}
const counts = (m: Mesh): Record<string, number> => {
  const out: Record<string, number> = {}
  const names = new Map(segmentTable(m).map(s => [s.id, s.name]))
  for (const l of m.segments?.labels ?? []) out[names.get(l) as string] = (out[names.get(l) as string] ?? 0) + 1
  return out
}
const colours = (m: Mesh): Record<string, string | undefined> => Object.fromEntries(segmentTable(m).map(s => [s.name, s.color]))

describe('colour slots in a 3MF that AtelierMesh wrote', () => {
  it('come back with their names, colours and triangles', async () => {
    const { mesh, map } = three()
    const applied = applyColourMap(mesh, map, { colours: { '1': { color: '#C0392B' }, '2': { color: '#2980B9' }, '3': { color: '#27AE60' } } })
    const r = await read3mf(write3mf(applied, { slicer: 'none' }).bytes)
    expect(counts(r.mesh)).toEqual({ body: 4, slot_2: 4, slot_3: 4 })
    expect(colours(r.mesh)).toEqual({ body: '#c0392b', slot_2: '#2980b9', slot_3: '#27ae60' })
    expect(r.colours).toBe(3)
    expect(r.mesh.groups).toBeUndefined()
  })
  it('stay separate when two slots have the same colour', async () => {
    const { mesh, map } = three()
    const applied = applyColourMap(mesh, map, { colours: { '1': { color: '#C0392B' }, '2': { color: '#2980B9' }, '3': { color: '#2980B9' } } })
    const r = await read3mf(write3mf(applied, { slicer: 'none' }).bytes)
    expect(counts(r.mesh)).toEqual({ body: 4, slot_2: 4, slot_3: 4 })
    expect(r.colours).toBe(2)
  })
  it('the same triangles are in the same slot as before the file', async () => {
    const { mesh, map } = three()
    const applied = applyColourMap(mesh, map, { colours: { '1': { color: '#111111' }, '2': { color: '#222222' }, '3': { color: '#333333' } } })
    const r = await read3mf(write3mf(applied, { slicer: 'none' }).bytes)
    const before = segmentTable(applied), after = segmentTable(r.mesh)
    for (let t = 0; t < applied.indices.length / 3; t++) {
      expect(after.find(s => s.id === (r.mesh.segments?.labels[t] as number))?.name).toBe(before.find(s => s.id === (applied.segments?.labels[t] as number))?.name)
    }
  })
  it('a slot without a colour is not in the file: its triangles are in the first slot', async () => {
    const { mesh, map } = three()
    const applied = applyColourMap(mesh, map, { colours: { '1': { color: '#111111' }, '2': { color: '#222222' } } })
    const r = await read3mf(write3mf(applied, { slicer: 'none' }).bytes)
    expect(counts(r.mesh)).toEqual({ body: 8, slot_2: 4 })
  })
  it('a file of another program is read per colour, as before', async () => {
    const { mesh, map } = three()
    const applied = applyColourMap(mesh, map, { colours: { '1': { color: '#C0392B' }, '2': { color: '#2980B9' }, '3': { color: '#2980B9' } } })
    const entries = await readZip(write3mf(applied, { slicer: 'none' }).bytes)
    const other = entries.map(e => e.name === '3D/3dmodel.model' ? { ...e, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('name="Application">AtelierMesh<', 'name="Application">Some Slicer<')) } : e)
    const r = await read3mf(writeZip(other))
    expect(counts(r.mesh)).toEqual({ material_1: 4, material_2: 8 })
    expect(Object.keys(counts(r.mesh)).includes('slot_2')).toBe(false)
  })
  it('a body that has a colour of its own is still a colour of the body, not a slot', async () => {
    const m = boxMesh(10, 10, 10)
    const n = m.indices.length / 3
    const r = await read3mf(write3mf({ ...m, groups: [{ name: 'Lid', role: 'solid', start: 0, count: n / 2, color: '#112233' }, { name: 'Base', role: 'solid', start: n / 2, count: n / 2, color: '#445566' }] }, { slicer: 'none' }).bytes)
    expect(r.mesh.groups?.map(g => [g.name, g.color])).toEqual([['Lid', '#112233'], ['Base', '#445566']])
    expect(r.mesh.segments).toBeUndefined()
  })
})
