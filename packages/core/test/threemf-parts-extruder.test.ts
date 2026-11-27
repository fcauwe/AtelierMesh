import { describe, expect, it } from 'vitest'
import { read3mf, segmentTable } from '../src'
import { writeZip } from '../src/zip'

// Bambu Studio and Creality Print keep the colour of a part in `Metadata/model_settings.config` (an extruder per part of an object), not as paint on its triangles.
const enc = new TextEncoder()
const tri = (id: number, dx: number) => `<object id="${id}" type="model"><mesh><vertices><vertex x="${dx}" y="0" z="0"/><vertex x="${dx + 1}" y="0" z="0"/><vertex x="${dx}" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`
const file = (settings: string | null, paint = ''): Uint8Array => {
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${tri(1, 0)}${tri(2, 5)}${tri(4, 10)}`
    + `<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/><component objectid="4"/></components></object></resources><build><item objectid="3"/></build></model>`
  const entries = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="r1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(model.replace('<triangle v1="0" v2="1" v3="2"/>', `<triangle v1="0" v2="1" v3="2"${paint}/>`)) },
    { name: 'Metadata/project_settings.config', data: enc.encode(JSON.stringify({ filament_colour: ['#FFFFFFFF', '#DA291CFF', '#000000FF'] })) },
  ]
  if (settings) entries.push({ name: 'Metadata/model_settings.config', data: enc.encode(settings) })
  return writeZip(entries)
}
const part = (id: number, e: number) => `<part id="${id}" subtype="normal_part"><metadata key="extruder" value="${e}"/></part>`

describe('reading the extruder of each part (Bambu Studio, Creality Print)', () => {
  it('gives every part the colour of its extruder', async () => {
    const r = await read3mf(file(`<config><object id="3"><metadata key="extruder" value="1"/>${part(1, 2)}${part(2, 3)}${part(4, 1)}</object></config>`))
    const names = segmentTable(r.mesh).map(s => [s.name, s.color])
    expect(names).toContainEqual(['extruder_2', '#da291c'])
    expect(names).toContainEqual(['extruder_3', '#000000'])
    expect(names).toContainEqual(['extruder_1', '#ffffff'])
    const byId = new Map(segmentTable(r.mesh).map(s => [s.name, s.id]))
    expect([...r.mesh.segments!.labels]).toEqual([byId.get('extruder_2'), byId.get('extruder_3'), byId.get('extruder_1')])
  })
  it('keeps the paint of a triangle over the extruder of its part', async () => {
    const r = await read3mf(file(`<config><object id="3">${part(1, 2)}${part(2, 3)}${part(4, 1)}</object></config>`, ' paint_color="4"'))
    const byId = new Map(segmentTable(r.mesh).map(s => [s.name, s.id]))
    expect(r.mesh.segments!.labels[0]).toBe(byId.get('extruder_1'))
  })
  it('a file where every part has the same extruder, or has no settings, stays one colour', async () => {
    expect((await read3mf(file(`<config><object id="3">${part(1, 1)}${part(2, 1)}${part(4, 1)}</object></config>`))).mesh.segments).toBeUndefined()
    expect((await read3mf(file(null))).mesh.segments).toBeUndefined()
  })
})
