import { describe, expect, it } from 'vitest'
import { buildPackage, emptyStepList, readZip, stripColours, write3mf } from '../src'
import type { Mesh } from '../src'

// One filament (the Atelier's first version): the file says nothing about colour or extruders. A part with coloured segments and a coloured body is the hard case.
const tetra = (): Mesh => ({
  positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  groups: [{ start: 0, count: 4, role: 'solid', name: 'Body', color: '#00ff00' }],
  segments: { labels: new Uint16Array([1, 1, 0, 0]), table: [{ id: 0, name: 'body' }, { id: 1, name: 'letters', color: '#e5484d' }] },
})
const text = (z: Record<string, Uint8Array>, name: string): string => new TextDecoder().decode(z[name] as Uint8Array)
const all = (z: Record<string, Uint8Array>): string => Object.keys(z).map(k => text(z, k)).join('\n')
const unzip = async (b: Uint8Array): Promise<Record<string, Uint8Array>> => { const o: Record<string, Uint8Array> = {}; for (const e of await readZip(b)) o[e.name] = e.data; return o }

describe('one filament: nothing about colour in final.3mf', () => {
  it('buildPackage with slicer none has no basematerials, no paint and no extruder data', async () => {
    const pkg = await unzip(buildPackage({ source: tetra(), final: tetra(), steps: emptyStepList(), slicer: 'none', palette: [{ segment: 'letters', extruder: 2, color: '#112233' }] }))
    const model = await unzip(pkg['final.3mf'] as Uint8Array)
    const xml = all(model)
    expect(xml).not.toMatch(/basematerials|displaycolor|pindex|mmu_segmentation|paint_color|slic3rpe|extruder/i)
    expect(Object.keys(model).some(k => /Slic3r|facets|config/i.test(k))).toBe(false)
  })
  it('the default package still carries colours (unchanged)', async () => {
    const model = await unzip((await unzip(buildPackage({ source: tetra(), final: tetra(), steps: emptyStepList() })))['final.3mf'] as Uint8Array)
    expect(all(model)).toMatch(/basematerials/)
  })
  it('write3mf with slicer none writes no paint or extruder data (the standard colours stay: strip them to be colourless)', async () => {
    const opts = { slicer: 'none' as const, palette: [{ segment: 'letters', extruder: 2 }], groupExtruders: { Body: 1 } }
    const coloured = all(await unzip(write3mf(tetra(), opts).bytes))
    expect(coloured).not.toMatch(/mmu_segmentation|paint_color|slic3rpe|extruder/i)
    expect(coloured).toMatch(/basematerials/)
    expect(all(await unzip(write3mf(stripColours(tetra()), opts).bytes))).not.toMatch(/basematerials|displaycolor/)
  })
  it('stripColours keeps the parts and their names', () => {
    const s = stripColours(tetra())
    expect(s.segments?.table.map(x => x.name)).toEqual(['body', 'letters'])
    expect(s.groups?.[0]?.name).toBe('Body')
    expect(JSON.stringify(s.segments?.table)).not.toMatch(/color/); expect(s.groups?.[0]).not.toHaveProperty('color')
  })
})
