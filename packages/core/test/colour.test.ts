import { describe, expect, it } from 'vitest'
import {
  MeshError, Registry, addStep, applyPermanently, assignSegment, colorSegments, decodeMesh, emptyStepList, encodeMesh, groupColor, isColor, loadProject, makeStep, meshColourProblem,
  PAINT_ATTR, PAINT_NS_URI, PAINT_PREFIX, read3mf, readZip, runWorkflow, saveProject, segmentColor, setGroupColor, setSegmentColor, write3mf, writeZip,
} from '../src'
import type { Manifest, Mesh, Operation } from '../src'

// ---- parts that carry colours: two unit boxes as two bodies
const box = (x0: number): { p: number[]; t: number[] } => {
  const p: number[] = []
  for (const x of [x0, x0 + 1]) for (const y of [0, 1]) for (const z of [0, 1]) p.push(x, y, z)
  const f = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
  const t: number[] = []
  for (const q of f) t.push(q[0] as number, q[1] as number, q[2] as number, q[0] as number, q[2] as number, q[3] as number)
  return { p, t }
}
const two = (): Mesh => {
  const a = box(0), b = box(3), nv = a.p.length / 3
  return { positions: Float64Array.from([...a.p, ...b.p]), indices: Uint32Array.from([...a.t, ...b.t.map(v => v + nv)]),
    groups: [{ start: 0, count: 12, role: 'solid', name: 'Lid' }, { start: 12, count: 12, role: 'solid', name: 'Base' }] }
}
const modelXml = async (bytes: Uint8Array): Promise<string> => new TextDecoder().decode((await readZip(bytes)).find(e => e.name === '3D/3dmodel.model')!.data)

// ---- a 3MF file made by hand: the model part is whatever the test gives
const file = (model: string): Uint8Array => {
  const enc = new TextEncoder()
  return writeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
  ])
}
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
// a tetra-like object of `n` triangles that share four vertices (valid indices, shape does not matter for colour tests)
const obj = (id: number, n: number, attrs = '', tri: (i: number) => string = () => ''): string =>
  `<object id="${id}" type="model" ${attrs}><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles>${Array.from({ length: n }, (_, i) => `<triangle v1="0" v2="1" v3="2" ${tri(i)}/>`).join('')}</triangles></mesh></object>`

describe('every part can carry a colour: bodies', () => {
  it('colours are #rrggbb or nothing: isColor and meshColourProblem', () => {
    expect(isColor('#a1B2c3')).toBe(true)
    for (const bad of ['red', '#abc', '#12345g', '#1234567', 3, undefined]) expect(isColor(bad)).toBe(false)
    expect(meshColourProblem(two())).toBeNull()
    const m = two(); m.groups![0]!.color = 'blue'
    expect(meshColourProblem(m)).toMatch(/group "Lid"/)
    const s = assignSegment(two(), 'text', new Uint8Array(24).fill(1)); s.segments!.table[1]!.color = '#12'
    expect(meshColourProblem(s)).toMatch(/segment "text"/)
  })
  it('setGroupColor, setSegmentColor and colorSegments set a colour and refuse a bad one', () => {
    const m = setGroupColor(two(), 'Lid', '#E5484D')
    expect(groupColor(m, 'Lid')).toBe('#e5484d'); expect(groupColor(m, 'Base')).toBeUndefined()
    expect(() => setGroupColor(two(), 'Nope', '#000000')).toThrow(MeshError)
    expect(() => setGroupColor(two(), 'Lid', 'red')).toThrowError(expect.objectContaining({ code: 'segment.bad_color' }))
    const flags = new Uint8Array(24); flags.fill(1, 0, 6)
    const s = assignSegment(two(), 'text', flags, '#30a46c')
    expect(segmentColor(s, 'text')).toBe('#30a46c')
    expect(segmentColor(setSegmentColor(s, 'text', '#112233'), 'text')).toBe('#112233')
    expect(segmentColor(colorSegments(s, { body: '#cccccc' }), 'body')).toBe('#cccccc')   // the default segment can carry a colour too
    expect(() => colorSegments(s, { unknown: '#000000' })).toThrowError(expect.objectContaining({ code: 'segment.unknown' }))
    expect(() => assignSegment(two(), 'text', flags, 'green')).toThrowError(expect.objectContaining({ code: 'segment.bad_color' }))
  })
  it('a body colour round-trips through 3MF (object colour and triangle colour), and files without colours stay as they were', async () => {
    const m = setGroupColor(setGroupColor(two(), 'Lid', '#e5484d'), 'Base', '#30a46c')
    const bytes = write3mf(m, { slicer: 'none' }).bytes
    const xml = await modelXml(bytes)
    expect(xml).toContain('<base name="Lid" displaycolor="#E5484DFF"/>')
    expect(xml).toMatch(/<object id="1" type="model" name="Lid" pid="3" pindex="0">/)
    const back = await read3mf(bytes)
    expect(back.mesh.groups!.map(g => [g.name, g.color])).toEqual([['Lid', '#e5484d'], ['Base', '#30a46c']])
    expect(back.colours).toBe(2)
    expect(back.mesh.segments).toBeUndefined()           // uniform colours on bodies are colours of the bodies, no segments
    const plain = await read3mf(write3mf(two(), { slicer: 'none' }).bytes)
    expect(plain.mesh.groups!.every(g => g.color === undefined)).toBe(true); expect(plain.mesh.segments).toBeUndefined(); expect(plain.colours).toBe(0)
    expect(() => write3mf({ ...two(), groups: [{ start: 0, count: 24, role: 'solid', name: 'Lid', color: 'red' }] })).toThrowError(expect.objectContaining({ code: 'export.bad_color' }))
  })
  it('a segment colour wins over the body colour on its triangles; the default segment colour is the layer below the body colour', async () => {
    let m = setGroupColor(two(), 'Lid', '#0000ff')
    const flags = new Uint8Array(24); flags.fill(1, 0, 4)
    m = assignSegment(m, 'text', flags, '#ff0000')
    const xml = await modelXml(write3mf(m, { slicer: 'none' }).bytes)
    const lid = /<object id="1"[\s\S]*?<\/object>/.exec(xml)![0]
    expect(lid.match(/p1="(\d+)"/g)!.slice(0, 4)).toEqual(['p1="0"', 'p1="0"', 'p1="0"', 'p1="0"'])      // base 0 = the segment colour (red)
    expect(lid.match(/p1="(\d+)"/g)!.slice(4)).toEqual(Array(8).fill('p1="1"'))                          // base 1 = the body colour (blue)
    const dflt = colorSegments(setGroupColor(two(), 'Lid', '#0000ff'), { body: '#cccccc' })
    const xml2 = await modelXml(write3mf(dflt, { slicer: 'none' }).bytes)
    expect(/<object id="1"[\s\S]*?<\/object>/.exec(xml2)![0].match(/p1="(\d+)"/g)!.every(x => x === 'p1="1"')).toBe(true)   // Lid: the body colour; Base has no body colour: the default one
    expect(/<object id="2"[\s\S]*?<\/object>/.exec(xml2)![0].match(/p1="(\d+)"/g)!.every(x => x === 'p1="0"')).toBe(true)
  })
  it('colours survive a project file (.amproj)', async () => {
    const m = setGroupColor(two(), 'Lid', '#e5484d')
    const back = await loadProject(saveProject({ name: 'x', base: m, list: emptyStepList(), rollback: null, assets: [] }))
    expect(groupColor(back.base!, 'Lid')).toBe('#e5484d')
    const dec = decodeMesh(encodeMesh(m))
    expect(groupColor(dec, 'Lid')).toBe('#e5484d')
  })
})

describe('reading colours from a 3MF file', () => {
  it('one colour for a whole object becomes the colour of that body', async () => {
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><basematerials id="9"><base name="red" displaycolor="#FF0000FF"/><base name="green" displaycolor="#00FF00"/></basematerials>${obj(1, 4, 'name="A" pid="9" pindex="0"')}${obj(2, 4, 'name="B"', () => 'pid="9" p1="1"')}</resources><build><item objectid="1"/><item objectid="2"/></build></model>`
    const r = await read3mf(file(xml))
    expect(r.mesh.groups!.map(g => [g.name, g.color])).toEqual([['A', '#ff0000'], ['B', '#00ff00']])
    expect(r.mesh.segments).toBeUndefined(); expect(r.colours).toBe(2)
  })
  it('a single-object file with one colour: the default segment carries it', async () => {
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><basematerials id="1"><base name="x" displaycolor="#112233FF"/></basematerials>${obj(2, 3, 'pid="1" pindex="0"')}</resources><build><item objectid="2"/></build></model>`
    const r = await read3mf(file(xml))
    expect(r.mesh.groups).toBeUndefined()
    expect(r.mesh.segments!.table).toEqual([{ id: 0, name: 'body', color: '#112233' }])
    expect(Array.from(r.mesh.segments!.labels)).toEqual([0, 0, 0])
  })
  it('several colours inside one object become segments material_1, material_2 ...', async () => {
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><basematerials id="1"><base name="a" displaycolor="#ff0000"/><base name="b" displaycolor="#0000ff"/></basematerials>${obj(2, 5, '', i => (i < 2 ? 'pid="1" p1="0"' : i < 4 ? 'pid="1" p1="1"' : ''))}</resources><build><item objectid="2"/></build></model>`
    const r = await read3mf(file(xml))
    expect(r.mesh.segments!.table).toEqual([{ id: 0, name: 'body' }, { id: 1, name: 'material_1', color: '#ff0000' }, { id: 2, name: 'material_2', color: '#0000ff' }])
    expect(Array.from(r.mesh.segments!.labels)).toEqual([1, 1, 2, 2, 0])     // the last triangle has no colour: the default segment
  })
  it('reads the materials extension (colorgroup) too', async () => {
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS} xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"><resources><m:colorgroup id="4"><m:color color="#AA00BBFF"/></m:colorgroup>${obj(2, 2, 'pid="4" pindex="0"')}</resources><build><item objectid="2"/></build></model>`
    expect((await read3mf(file(xml))).mesh.segments!.table[0]).toEqual({ id: 0, name: 'body', color: '#aa00bb' })
  })
  it('more than 64 colours are reduced to 64 with a warning; the nearest kept colour is used', async () => {
    const bases = Array.from({ length: 70 }, (_, i) => `<base name="c${i}" displaycolor="#${(i * 3).toString(16).padStart(2, '0')}${(255 - i * 3).toString(16).padStart(2, '0')}10"/>`).join('')
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS}><resources><basematerials id="1">${bases}</basematerials>${obj(2, 70, '', i => `pid="1" p1="${i}"`)}</resources><build><item objectid="2"/></build></model>`
    const r = await read3mf(file(xml))
    expect(r.warnings.map(w => w.code)).toContain('import.colours_reduced')
    expect(r.warnings.find(w => w.code === 'import.colours_reduced')!.params).toEqual({ found: 70, kept: 64 })
    expect(r.colours).toBe(64)
    expect(r.mesh.segments!.table.length).toBe(65)                // the default segment and 64 colours
    expect(new Set(r.mesh.segments!.table.slice(1).map(s => s.color)).size).toBe(64)
    expect(r.mesh.segments!.labels.every(l => l >= 1)).toBe(true)
  })
  it('the slicer paint of a triangle wins over its material colour', async () => {
    const xml = `<?xml version="1.0"?><model unit="millimeter" ${NS} xmlns:${PAINT_PREFIX}="${PAINT_NS_URI}"><resources><basematerials id="1"><base name="a" displaycolor="#ff0000"/></basematerials>${obj(2, 2, 'pid="1" pindex="0"', i => (i === 0 ? `${PAINT_ATTR}="8"` : ''))}</resources><build><item objectid="2"/></build></model>`
    const r = await read3mf(file(xml))
    expect(r.paintedTriangles).toBe(1)
    expect(r.mesh.segments!.table.map(s => s.name)).toEqual(['body', 'extruder_2'])
  })
})

// ---- colours survive the places that keep groups and segments
const trivial: Manifest = { manifest_version: 1, id: 'test.colour', name: 'T', version: '1.0.0', operations: [{ id: 'keep', kind: 'modifier', params: [] } as unknown as Operation, { id: 'bad', kind: 'modifier', params: [] } as unknown as Operation] }
describe('a plugin result may carry colours, and only valid ones', () => {
  const registry = (mesh: (m: Mesh, op: string) => Mesh): Registry => new Registry().register({ manifest: trivial, load: () => ({ run: (op: string, ctx: { mesh: unknown }) => ({ mesh: mesh(ctx.mesh as Mesh, op) }) }) } as never)
  const list = (op: string) => addStep(emptyStepList(), makeStep({ id: 's1', plugin: { id: 'test.colour', version: '1.0.0' }, op, params: {} }))
  it('a plugin that sets a colour on a new segment and on a body gets it back', async () => {
    const r = registry((m, op) => (op === 'keep' ? setGroupColor(assignSegment(m, 'top', new Uint8Array(24).fill(1, 0, 3), '#ffd400'), 'Base', '#123456') : m))
    const res = await runWorkflow(list('keep'), { registry: r, source: two() })
    expect(res.ok).toBe(true)
    expect(segmentColor(res.mesh!, 'top')).toBe('#ffd400'); expect(groupColor(res.mesh!, 'Base')).toBe('#123456')
  })
  it('a colour that is not #rrggbb is refused (plugin.bad_mesh)', async () => {
    const r = registry(m => ({ ...m, groups: m.groups!.map(g => ({ ...g, color: 'blue' })) }))
    const res = await runWorkflow(list('bad'), { registry: r, source: two() })
    expect(res.ok).toBe(false)
    expect(res.results[0]!.error).toMatchObject({ code: 'plugin.bad_mesh' })
    expect(JSON.stringify(res.results[0]!.error)).toContain('not #rrggbb')
  })
})

describe('colour survives applyPermanently', () => {
  it('the colours of the steps\' result stay on the base mesh', async () => {
    const r = new Registry().register({ manifest: trivial, load: () => ({ run: (_op: string, ctx: { mesh: Mesh }) => ({ mesh: setGroupColor(ctx.mesh, 'Lid', '#e5484d') }) }) } as never)
    const list = addStep(emptyStepList(), makeStep({ id: 's1', plugin: { id: 'test.colour', version: '1.0.0' }, op: 'keep', params: {} }))
    const { state } = await applyPermanently({ base: two(), list, rollback: null }, { registry: r })
    expect(groupColor(state.base!, 'Lid')).toBe('#e5484d')
  })
})
