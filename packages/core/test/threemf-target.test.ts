import { describe, expect, it } from 'vitest'
import { applyColourMap, buildPackage, colourMapFromMesh, emptyStepList, read3mf, segmentTable, write3mf } from '../src'
import { readZip, writeZip } from '../src/zip'
import { boxMesh } from '../src/testing'

// What a slicer needs to show every colour of a two-colour model. EasyPrint (PrusaSlicer's engine) showed one colour until the file had the paint version line and the project's
// extruder colours; a file made by PrusaSlicer itself is the model for `prusa`, one made by Bambu Studio for `bambu` (docs/3mf-colour.md section 4c).
const two = () => {
  const m = boxMesh(10, 10, 10)
  const labels = new Uint16Array(m.indices.length / 3); for (let i = 0; i < labels.length; i++) labels[i] = i % 2
  const mesh = { ...m, segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'text' }] } }
  const a = applyColourMap(mesh, { slots: [{ id: '1', name: 'Part', parts: ['body'] }, { id: '2', name: 'Text', parts: ['text'] }] }, { colours: { '1': { color: '#2563eb' }, '2': { color: '#ea580c' } } })
  return { a, palette: [{ segment: 'slot_2', extruder: 2, color: '#EA580C' }] }
}
const files = async (bytes: Uint8Array): Promise<Record<string, string>> => Object.fromEntries((await readZip(bytes)).map(e => [e.name, new TextDecoder().decode(e.data)]))

describe('write3mf target', () => {
  it('prusa: paint, versions, named object without an extruder, and the extruder colours', async () => {
    const { a, palette } = two()
    const f = await files(write3mf(a, { title: 'Tag', palette, target: 'prusa' }).bytes)
    const model = f['3D/3dmodel.model'] as string
    expect(model).toContain('<metadata name="slic3rpe:Version3mf">1</metadata>')
    expect(model).toContain('<metadata name="slic3rpe:MmPaintingVersion">1</metadata>')
    expect(model).toContain('<object id="1" type="model" name="Tag">')
    expect(model).toContain('slic3rpe:mmu_segmentation="8"')
    expect(model).not.toContain('paint_color')
    expect(f['Metadata/Slic3r_PE_model.config']).toContain('key="name" value="Tag"')
    expect(f['Metadata/Slic3r_PE_model.config']).not.toContain('key="extruder"')
    expect(f['Metadata/Slic3r_PE.config']).toContain('; extruder_colour = #2563EB;#EA580C\n')
    // PrusaSlicer 3.0 reads the paint from this file and ignores the attribute on the triangle
    expect(JSON.parse(f['Metadata/Slic3r_facets_annotation.json'] as string)).toEqual([{ id: 1, mmSegmentationFacets: expect.any(Array), mmSegmentationFacetsVersion: 1 }])
  })
  it('bambu: the paint under its own name, object settings and filament colours', async () => {
    const { a, palette } = two()
    const f = await files(write3mf(a, { title: 'Tag', palette, target: 'bambu' }).bytes)
    const model = f['3D/3dmodel.model'] as string
    expect(model).toContain('paint_color="8"')
    expect(model).not.toContain('mmu_segmentation')
    expect(model).toContain('BambuStudio:3mfVersion')
    expect(f['Metadata/model_settings.config']).toContain('key="name" value="Tag"')
    expect(JSON.parse(f['Metadata/project_settings.config'] as string)).toEqual({ filament_colour: ['#2563EB', '#EA580C'] })
  })
  it('no target: the file is as it was', async () => {
    const { a, palette } = two()
    const f = await files(write3mf(a, { palette }).bytes)
    expect(Object.keys(f).sort()).toEqual(['3D/3dmodel.model', 'Metadata/Slic3r_facets_annotation.json', '[Content_Types].xml', '_rels/.rels'])
  })
  it('buildPackage: the host sets the target of final.3mf, and geometry only wins', async () => {
    const { a, palette } = two()
    const final3mf = async (extra: object): Promise<Record<string, string>> => {
      const entry = (await readZip(buildPackage({ source: a, final: a, steps: emptyStepList(), palette, title: 'Tag', ...extra }))).find(e => e.name === 'final.3mf')
      return files(entry!.data)
    }
    expect((await final3mf({ target: 'prusa' }))['Metadata/Slic3r_PE.config']).toContain('; extruder_colour = #2563EB;#EA580C')
    expect(Object.keys(await final3mf({ target: 'bambu' }))).toContain('Metadata/model_settings.config')
    expect(Object.keys(await final3mf({ target: 'prusa', slicer: 'none' })).some(k => k.includes('Slic3r'))).toBe(false)
  })
  it('reads our own file back with its slots, whichever target wrote it', async () => {
    const { a, palette } = two()
    for (const o of [{}, { slicer: 'none' }, { target: 'prusa' }, { target: 'bambu' }]) {
      const r = await read3mf(write3mf(a, { title: 'Tag', palette, ...o } as never).bytes)
      expect(segmentTable(r.mesh).map(s => [s.name, s.color]), JSON.stringify(o)).toEqual([['body', '#2563eb'], ['slot_2', '#ea580c']])
      expect(r.mesh.segments!.labels.filter(l => l === 1).length).toBe(6)
    }
  })
  it('gives the paint of another program the colour of its extruder, from PrusaSlicer or Bambu Studio settings', async () => {
    const { a, palette } = two()
    // the same paint, but written by "PrusaSlicer": no Application=AtelierMesh, so no slots, only paint and the project's extruder colours
    const swap = async (bytes: Uint8Array, extra: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array> => {
      const { writeZip } = await import('../src/zip')
      const es = (await readZip(bytes)).map(e => (e.name === '3D/3dmodel.model' ? { ...e, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('AtelierMesh', 'PrusaSlicer-2.7.4').replace(/ pid="\d+" p1="\d+"/g, '')) } : e))
      return writeZip([...es.filter(e => !extra.some(x => x.name === e.name)), ...extra])
    }
    const pe = await swap(write3mf(a, { palette, target: 'prusa' }).bytes, [{ name: 'Metadata/Slic3r_PE.config', data: new TextEncoder().encode('; extruder_colour = #FF0000;#00FF00;"#0000FF"\n') }])
    expect(segmentTable((await read3mf(pe)).mesh).find(s => s.name === 'extruder_2')?.color).toBe('#00ff00')
    const bb = await swap(write3mf(a, { palette, target: 'bambu' }).bytes, [{ name: 'Metadata/project_settings.config', data: new TextEncoder().encode(JSON.stringify({ filament_colour: ['#111111', '#222222FF'] })) }])
    expect(segmentTable((await read3mf(bb)).mesh).find(s => s.name === 'extruder_2')?.color).toBe('#222222')
  })
  it('the paint only in the sidecar file (as PrusaSlicer 3.0 writes it) is read like the paint on the triangles', async () => {
    const { a, palette } = two()
    const entries = await readZip(write3mf(a, { palette, target: 'prusa' }).bytes)
    const dec = new TextDecoder(), enc = new TextEncoder()
    const strip = entries.map(e => e.name === '3D/3dmodel.model' ? { ...e, data: enc.encode(dec.decode(e.data).replace(/ slic3rpe:mmu_segmentation="[^"]*"/g, '')) } : e)
    const inline = await read3mf(write3mf(a, { palette, target: 'prusa' }).bytes)
    const side = await read3mf(writeZip(strip))
    expect(side.paintedTriangles).toBe(inline.paintedTriangles)
    expect(side.paintedTriangles).toBeGreaterThan(0)
  })
  it('a model with several colours starts with them as colour slots (the unpainted part first, one slot per painted segment with its colour)', async () => {
    const { a, palette } = two()
    // our own file: the slots come back with their ids and colours
    const own = colourMapFromMesh((await read3mf(write3mf(a, { title: 'Tag', palette, target: 'prusa' }).bytes)).mesh)
    expect(own?.slots.map(s => [s.id, s.parts, s.color])).toEqual([['1', ['*'], '#2563eb'], ['2', ['slot_2'], '#ea580c']])
    // a file of another program: paint with extruder colours from its project settings
    const other = async (bytes: Uint8Array): Promise<Uint8Array> => {
      const es = (await readZip(bytes)).map(e => (e.name === '3D/3dmodel.model' ? { ...e, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('AtelierMesh', 'PrusaSlicer-2.7.4').replace(/ pid="\d+" p1="\d+"/g, '')) } : e.name === 'Metadata/Slic3r_PE.config' ? { ...e, data: new TextEncoder().encode('; extruder_colour = #FF0000;#00FF00\n') } : e))
      return writeZip(es)
    }
    const m = colourMapFromMesh((await read3mf(await other(write3mf(a, { palette, target: 'prusa' }).bytes))).mesh)
    expect(m?.slots.map(s => [s.id, s.parts, s.color])).toEqual([['1', ['*'], undefined], ['2', ['extruder_2'], '#00ff00']])
    // nothing painted: one colour, no map
    expect(colourMapFromMesh(boxMesh(10, 10, 10))).toBeUndefined()
  })
})
