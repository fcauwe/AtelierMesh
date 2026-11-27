import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION_META, FACETS_FILE, OBJECT_CONFIG_FILE, PAINT_ATTR, PAINT_ATTR_ALT, PAINT_NS_URI, PAINT_PREFIX, assignSegment, borderVertices, carrySegments, checkSegments, convertToMm, crc32, decodePaint, encodePaint, meshReport, measureMesh,
  parseStl, read3mf, readZip, segmentId, selectTriangles, unitHint, validateParams, weldSoup, write3mf, writeStlAscii, writeStlBinary, writeZip,
  type Mesh,
} from '../src'
import { boxMesh, cylinderMesh, lBracketMesh, sphereMesh } from '../src/testing'

const sameShape = (a: Mesh, b: Mesh, tol = 1e-4): void => {
  const x = measureMesh(a), y = measureMesh(b)
  expect(y.triangles).toBe(x.triangles)
  expect(y.volume).toBeCloseTo(x.volume, 3)
  for (let i = 0; i < 3; i++) { expect(y.size[i]).toBeCloseTo(x.size[i] as number, 3); expect(Math.abs((y.bbox.min[i] as number) - (x.bbox.min[i] as number))).toBeLessThan(tol) }
}

describe('weld', () => {
  it('joins shared corners and drops degenerate triangles', () => {
    const soup = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5, 5, 5, 5, 6, 6, 6]
    const r = weldSoup(soup)
    expect(r.mesh.positions.length / 3).toBe(4); expect(r.mesh.indices.length / 3).toBe(2); expect(r.degenerate).toBe(1)
  })
})

describe('STL', () => {
  const part = lBracketMesh()
  it('round-trips binary with the same dimensions and orientation', () => {
    const r = parseStl(writeStlBinary(part))
    expect(r.format).toBe('binary'); sameShape(part, r.mesh)
    expect(measureMesh(r.mesh).watertight).toBe(true)
  })
  it('round-trips ascii', () => {
    const r = parseStl(writeStlAscii(part))
    expect(r.format).toBe('ascii'); sameShape(part, r.mesh)
  })
  it('a binary file whose header starts with solid is still binary', () => {
    const bytes = writeStlBinary(boxMesh(1, 2, 3)); bytes.set(new TextEncoder().encode('solid trap'), 0)
    expect(parseStl(bytes).format).toBe('binary')
  })
  it('refuses garbage and over-budget files', () => {
    expect(() => parseStl(new Uint8Array(10))).toThrow(/import|stl/i)
    expect(() => parseStl(writeStlBinary(sphereMesh(5, 3)), { maxTriangles: 100 })).toThrowError(expect.objectContaining({ code: 'budget.triangles' }))
  })
  it('a 20 mm cube reads back with volume 8000', () => {
    const r = parseStl(writeStlBinary(boxMesh(20, 20, 20)))
    expect(measureMesh(r.mesh).volume).toBeCloseTo(8000, 3); expect(measureMesh(r.mesh).size).toEqual([20, 20, 20])
  })
})

describe('units', () => {
  it('flags an inch-sized part and converts', () => {
    const inch = boxMesh(2, 1, 0.5)
    expect(unitHint(inch).suspect).toBe('inch')
    expect(measureMesh(convertToMm(inch, 'inch')).size[0]).toBeCloseTo(50.8)
    expect(unitHint(boxMesh(40, 20, 10)).suspect).toBeNull()
    expect(unitHint(boxMesh(0.04, 0.02, 0.01)).suspect).toBe('m')
  })
})

describe('report', () => {
  it('a closed part has no issues', () => { expect(meshReport(lBracketMesh()).issues).toEqual([]) })
  it('finds a hole, shells and a unit suspect', () => {
    const b = boxMesh(1, 1, 1); b.indices = b.indices.slice(0, 33)
    expect(meshReport(b).issues).toEqual(expect.arrayContaining(['not_watertight', 'unit_suspect']))
    const two = { positions: Float64Array.from([...boxMesh(10, 10, 10).positions, ...boxMesh(10, 10, 10).positions.map((v, i) => (i % 3 === 0 ? v + 100 : v))]), indices: Uint32Array.from([...boxMesh(10, 10, 10).indices, ...boxMesh(10, 10, 10).indices.map(i => i + 8)]) }
    const r = meshReport(two); expect(r.shells).toBe(2); expect(r.issues).toContain('many_shells')
  })
})

describe('ZIP', () => {
  const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/b.bin', data: Uint8Array.from([1, 2, 3]) }]
  it('writes deterministic bytes and reads them back', async () => {
    const z = writeZip(files)
    expect(writeZip(files)).toEqual(z)
    const back = await readZip(z)
    expect(back.map(e => e.name)).toEqual(['a.txt', 'dir/b.bin']); expect(new TextDecoder().decode(back[0]!.data)).toBe('hello')
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('inflates a deflate-compressed entry written by another tool', async () => {
    const raw = new TextEncoder().encode('x'.repeat(5000))
    const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); void w.write(raw); void w.close()
    const comp = new Uint8Array(await new Response(cs.readable).arrayBuffer())
    const z = writeZip([{ name: 'big.txt', data: comp }])
    const dv = new DataView(z.buffer)
    dv.setUint16(8, 8, true); dv.setUint32(22, raw.length, true) // local: method deflate, usize
    const cd = dv.getUint32(z.length - 22 + 16, true)
    dv.setUint16(cd + 10, 8, true); dv.setUint32(cd + 24, raw.length, true); dv.setUint32(cd + 16, crc32(raw), true); dv.setUint32(14, crc32(raw), true)
    const back = await readZip(z)
    expect(back[0]!.data.length).toBe(5000)
  })
  it('refuses corrupt, unsafe, duplicate and bomb archives', async () => {
    const z = writeZip(files)
    await expect(readZip(z.slice(0, 20))).rejects.toMatchObject({ code: 'import.invalid_zip' })
    const flipped = z.slice(); flipped[35] ^= 0xff
    await expect(readZip(flipped)).rejects.toMatchObject({ code: 'import.invalid_zip', params: { reason: 'checksum_mismatch' } })
    await expect(readZip(writeZip([{ name: '../evil', data: new Uint8Array(1) }]))).rejects.toMatchObject({ params: { reason: 'unsafe_name' } })
    await expect(readZip(writeZip([{ name: '/abs', data: new Uint8Array(1) }]))).rejects.toMatchObject({ params: { reason: 'unsafe_name' } })
    await expect(readZip(writeZip([{ name: 'a', data: new Uint8Array(1) }, { name: 'a', data: new Uint8Array(1) }]))).rejects.toMatchObject({ params: { reason: 'duplicate_name' } })
    await expect(readZip(z, { maxEntryBytes: 2 })).rejects.toMatchObject({ params: { reason: 'entry_too_large' } })
    await expect(readZip(z, { maxTotalBytes: 4 })).rejects.toMatchObject({ params: { reason: 'archive_too_large' } })
    // a bomb: a tiny deflate stream that claims to be small but expands
    const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); void w.write(new Uint8Array(2_000_000)); void w.close()
    const comp = new Uint8Array(await new Response(cs.readable).arrayBuffer())
    const bomb = writeZip([{ name: 'bomb', data: comp }]); const dv = new DataView(bomb.buffer)
    const cd = dv.getUint32(bomb.length - 22 + 16, true)
    dv.setUint16(8, 8, true); dv.setUint32(22, 100, true); dv.setUint16(cd + 10, 8, true); dv.setUint32(cd + 24, 100, true) // lies: 100 bytes
    await expect(readZip(bomb)).rejects.toMatchObject({ code: 'import.invalid_zip' })
    // honest but absurd ratio
    dv.setUint32(22, 2_000_000, true); dv.setUint32(cd + 24, 2_000_000, true)
    await expect(readZip(bomb, { maxRatio: 100 })).rejects.toMatchObject({ params: { reason: 'compression_ratio_too_high' } })
  })
})

describe('paint strings', () => {
  it('encodes the whole-triangle table (docs/3mf-colour.md section 3)', () => {
    const want: Record<number, string> = { 1: '4', 2: '8', 3: '0C', 4: '1C', 5: '2C', 6: '3C', 7: '4C', 8: '5C', 9: '6C', 10: '7C', 11: '8C', 12: '9C', 13: 'AC', 14: 'BC', 15: 'CC', 16: 'DC' }
    for (const [n, s] of Object.entries(want)) { expect(encodePaint(Number(n))).toBe(s); expect(decodePaint(s)).toEqual({ state: Number(n), split: false }) }
    expect(() => encodePaint(0)).toThrow(); expect(() => encodePaint(17)).toThrow()
  })
  it('decodes extended states and the split example', () => {
    expect(decodePaint('00EC')?.state).toBe(17); expect(decodePaint('EEEC')?.state).toBe(255)
    const d = decodePaint('481'); expect(d?.split).toBe(true); expect(d?.state).toBeGreaterThan(0)
    expect(decodePaint('zz')).toBeNull(); expect(decodePaint('')).toBeNull()
  })
})

describe('segments', () => {
  const box = boxMesh(10, 10, 10)
  it('assigns, selects, finds borders, carries labels, and validates', () => {
    const flags = new Uint8Array(12); flags[4] = 1; flags[5] = 1 // two triangles
    const m = assignSegment(box, 'grip', flags, '#ff0000')
    expect(m.segments!.table.map(s => s.name)).toEqual(['body', 'grip']); expect(checkSegments(m)).toEqual([])
    expect(segmentId(m, 'grip')).toBe(1)
    const sel = selectTriangles(m, 'grip')!; expect([...sel].reduce((a, b) => a + b, 0)).toBe(2)
    expect(selectTriangles(m, '')).toBeNull()
    expect(() => segmentId(m, 'nope')).toThrowError(expect.objectContaining({ code: 'segment.unknown' }))
    expect([...borderVertices(m, sel)].some(v => v === 1)).toBe(true)
    const carried = carrySegments(m, [4, 4, 5, 0, 1])!
    expect([...carried.labels]).toEqual([1, 1, 1, 0, 0])
    expect(() => assignSegment(box, 'Bad Name', flags)).toThrow()
    const replaced = assignSegment(m, 'grip', new Uint8Array(12)); expect(replaced.segments!.table.length).toBe(2)
  })
  it('a segment that loses all its triangles is dropped from the table', () => {
    const f = new Uint8Array(12); f[0] = 1
    const a = assignSegment(box, 'x', f)
    const b = assignSegment(a, 'body', f) // the same triangle goes back to body
    expect(b.segments!.table.map(s => s.name)).toEqual(['body'])
  })
  it('the segment parameter type validates names', () => {
    const op = { id: 'o', kind: 'modifier' as const, params: [{ name: 'segment', type: 'part' as const, kinds: ['segment' as const], default: '' }, { name: 'must', type: 'part' as const, kinds: ['segment' as const], default: 'a', allow_empty: false }] }
    expect(validateParams(op, {}).ok).toBe(true)
    expect(validateParams(op, { segment: 'Part 6' }).ok).toBe(true)                                   // a name from a file may have capitals and spaces
    expect(validateParams(op, { segment: 'x'.repeat(121) }).errors[0]?.code).toBe('param.pattern')   // but not be endless
    expect(validateParams(op, { segment: 'a\u0001b' }).errors[0]?.code).toBe('param.pattern')
    expect(validateParams(op, { must: '' }).errors[0]?.code).toBe('param.pattern')
    expect(validateParams(op, { segment: 3 }).errors[0]?.code).toBe('param.type')
  })
})

describe('3MF', () => {
  it('round-trips triangles, volume and size', async () => {
    const part = lBracketMesh()
    const { bytes, warnings } = write3mf(part, { title: 'bracket', metadata: { stepListHash: 'abc' } })
    expect(warnings).toEqual([])
    const back = await read3mf(bytes)
    sameShape(part, back.mesh); expect(back.unit).toBe('millimeter'); expect(back.metadata['am:stepListHash']).toBe('abc'); expect(back.paintedTriangles).toBe(0)
    expect(measureMesh(back.mesh).watertight).toBe(true)
  })
  it('writes the slicer attribute for a mapped segment and reads it back as a segment (by its name)', async () => {
    const box = boxMesh(10, 10, 10)
    const f = new Uint8Array(12); f[8] = 1; f[9] = 1
    const m = assignSegment(box, 'text', f)
    const { bytes } = write3mf(m, { palette: [{ segment: 'text', color: '#ffffff', extruder: 2 }] })
    const files = await readZip(bytes)
    const xml = new TextDecoder().decode(files.find(e => e.name === '3D/3dmodel.model')!.data)
    expect(xml).toContain(`xmlns:${PAINT_PREFIX}="${PAINT_NS_URI}"`)
    expect(xml.split(`${PAINT_ATTR}="8"`).length - 1).toBe(2)
    expect(xml).toContain('<basematerials'); expect(xml).toContain('displaycolor="#FFFFFFFF"')
    expect(xml).not.toContain('paint_color')
    const back = await read3mf(bytes)
    expect(back.paintedTriangles).toBe(2); expect(back.mesh.segments!.table.map(s => s.name)).toEqual(['body', 'text'])   // a file AtelierMesh wrote: the material's name wins over the extruder number
    expect([...back.mesh.segments!.labels].filter(l => l === 1).length).toBe(2)
    const both = new TextDecoder().decode((await readZip(write3mf(m, { slicer: 'all', palette: [{ segment: 'text', extruder: 3 }] }).bytes)).find(e => e.name === '3D/3dmodel.model')!.data)
    expect(both).toContain(`${PAINT_ATTR_ALT}="0C"`); expect(both).toContain(`${PAINT_ATTR}="0C"`)
    const none = new TextDecoder().decode((await readZip(write3mf(m, { slicer: 'none', palette: [{ segment: 'text', extruder: 2, color: '#00ff00' }] }).bytes)).find(e => e.name === '3D/3dmodel.model')!.data)
    expect(none).not.toContain(PAINT_ATTR); expect(none).not.toContain(`xmlns:${PAINT_PREFIX}`)
  })
  it('writes bodies as objects and drops negative ones with a warning', async () => {
    const a = boxMesh(10, 10, 10), b = boxMesh(4, 4, 4)
    const mesh: Mesh = { positions: Float64Array.from([...a.positions, ...b.positions]), indices: Uint32Array.from([...a.indices, ...b.indices.map(i => i + 8)]),
      groups: [{ start: 0, count: 12, role: 'solid', name: 'main' }, { start: 12, count: 12, role: 'negative', name: 'hole' }] }
    const r = write3mf(mesh)
    expect(r.warnings[0]?.code).toBe('export.negative_dropped')
    const back = await read3mf(r.bytes)
    expect(back.mesh.indices.length / 3).toBe(12); expect(measureMesh(back.mesh).volume).toBeCloseTo(1000)
  })
  it('rejects bad palette entries and bad meshes', () => {
    expect(() => write3mf(boxMesh(1, 1, 1), { palette: [{ segment: 'x', extruder: 99 }] })).toThrowError(expect.objectContaining({ code: 'export.bad_extruder' }))
    expect(() => write3mf(boxMesh(1, 1, 1), { palette: [{ segment: 'x', color: 'red' }] })).toThrowError(expect.objectContaining({ code: 'export.bad_color' }))
    expect(() => write3mf({ positions: Float64Array.from([NaN, 0, 0]), indices: new Uint32Array(0) })).toThrowError(expect.objectContaining({ code: 'export.invalid_mesh' }))
  })
  const model = (inner: string, head = 'unit="millimeter"') => writeZip([
    { name: '_rels/.rels', data: new TextEncoder().encode('<Relationships xmlns="x"><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: new TextEncoder().encode(`<?xml version="1.0"?><model ${head} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">${inner}</model>`) },
  ])
  const tet = '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles>'
  it('reads units, transforms, components and flips mirrored triangles', async () => {
    const inch = await read3mf(model(`<resources><object id="1" type="model"><mesh>${tet}</mesh></object></resources><build><item objectid="1"/></build>`, 'unit="inch"'))
    expect(inch.mesh.positions[3]).toBeCloseTo(25.4)
    const moved = await read3mf(model(`<resources><object id="1"><mesh>${tet}</mesh></object><object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></build>`))
    expect(moved.mesh.positions[0]).toBeCloseTo(10); expect(moved.mesh.positions[1]).toBeCloseTo(5)
    const mirror = await read3mf(model(`<resources><object id="1"><mesh>${tet}</mesh></object></resources><build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build>`))
    expect(measureMesh(mirror.mesh).volume).toBeGreaterThan(0)
  })
  it('refuses broken and unsupported files', async () => {
    await expect(read3mf(model('<resources></resources>'))).rejects.toMatchObject({ code: 'import.invalid_3mf' })
    await expect(read3mf(model(`<resources><object id="1"><mesh>${tet.replace('v3="3"/></triangles>', 'v3="9"/></triangles>')}</mesh></object></resources><build><item objectid="1"/></build>`))).rejects.toMatchObject({ code: 'import.invalid_3mf' })
    await expect(read3mf(model(`<resources><object id="1"><mesh>${tet}</mesh></object></resources><build><item objectid="1" p:path="/3D/Objects/o.model"/></build>`))).rejects.toMatchObject({ params: { reason: 'missing_model_part' } })
    await expect(read3mf(model('<resources/>', 'unit="millimeter" requiredextensions="m"'))).rejects.toMatchObject({ params: { reason: 'required_extension_not_supported' } })
    await expect(read3mf(writeZip([{ name: 'x.txt', data: new Uint8Array(1) }]))).rejects.toMatchObject({ code: 'import.invalid_3mf' })
    const dtd = writeZip([{ name: '3D/3dmodel.model', data: new TextEncoder().encode('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><model/>') }])
    await expect(read3mf(dtd)).rejects.toMatchObject({ params: { reason: 'dtd_not_allowed' } })
    await expect(read3mf(write3mf(sphereMesh(5, 3)).bytes, { limits: { maxTriangles: 10 } })).rejects.toMatchObject({ code: 'budget.triangles' })
  })
  it('writes the paint as an attribute, as a sidecar file or both, and reads each back', async () => {
    const m = assignSegment(boxMesh(10, 10, 10), 'text', Uint8Array.from([0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]), '#ffffff')
    const pal = [{ segment: 'text', extruder: 2, color: '#ffffff' }]
    const names = async (slicer: 'inline_sidecar' | 'inline' | 'sidecar' | 'none') => (await readZip(write3mf(m, { slicer, palette: pal }).bytes)).map(e => e.name)
    expect(await names('inline')).not.toContain(FACETS_FILE)
    expect(await names('sidecar')).toContain(FACETS_FILE)
    expect(await names('inline_sidecar')).toContain(FACETS_FILE)
    expect(await names('none')).not.toContain(FACETS_FILE)
    const xmlOf = async (slicer: 'inline_sidecar' | 'inline' | 'sidecar'): Promise<string> => new TextDecoder().decode((await readZip(write3mf(m, { slicer, palette: pal }).bytes)).find(e => e.name === '3D/3dmodel.model')!.data)
    expect(await xmlOf('inline')).toContain(`${PAINT_ATTR}="8"`)
    expect(await xmlOf('sidecar')).not.toContain(PAINT_ATTR)
    for (const slicer of ['inline', 'sidecar', 'inline_sidecar'] as const) {
      const back = await read3mf(write3mf(m, { slicer, palette: pal }).bytes)
      expect(back.paintedTriangles, slicer).toBe(2)
      expect(back.mesh.segments!.labels[2], slicer).toBe(1)
      expect(back.mesh.segments!.labels[0], slicer).toBe(0)
    }
  })
  it('writes an extruder per body in the object configuration file (with the attribute forms), and not for the sidecar-only form or none', async () => {
    const a = boxMesh(10, 10, 10), b = boxMesh(10, 10, 10)
    const m: Mesh = { positions: Float64Array.from([...a.positions, ...b.positions.map((v, i) => (i % 3 === 0 ? v + 20 : v))]), indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, i => i + 8)]), groups: [{ start: 0, count: 12, role: 'solid', name: 'partA' }, { start: 12, count: 12, role: 'solid', name: 'partB' }] }
    const names = async (slicer: 'inline_sidecar' | 'inline' | 'sidecar' | 'none') => new Map((await readZip(write3mf(m, { slicer, groupExtruders: { partA: 1, partB: 3 } }).bytes)).map(e => [e.name, new TextDecoder().decode(e.data)]))
    const f = await names('inline')
    const cfg = f.get(OBJECT_CONFIG_FILE)!
    expect(cfg).toContain('key="extruder" value="3"'); expect(cfg).toContain('value="partB"')
    expect(f.get('3D/3dmodel.model')).toContain(CONFIG_VERSION_META)
    expect((await names('inline_sidecar')).has(OBJECT_CONFIG_FILE)).toBe(true)
    expect((await names('sidecar')).has(OBJECT_CONFIG_FILE)).toBe(false)
    expect((await names('none')).has(OBJECT_CONFIG_FILE)).toBe(false)
    expect(() => write3mf(m, { groupExtruders: { partA: 17 } })).toThrowError(expect.objectContaining({ code: 'export.bad_extruder' }))
    // the model still reads back as the same two bodies' triangles
    expect((await read3mf(write3mf(m, { groupExtruders: { partA: 1, partB: 3 } }).bytes)).mesh.indices.length / 3).toBe(24)
  })

  it('follows the Production extension: objects in other model parts', async () => {
    const enc = (t: string) => new TextEncoder().encode(t)
    const head = (ext: string) => `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"${ext}>`
    const rels = { name: '_rels/.rels', data: enc('<Relationships xmlns="x"><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') }
    const sub = (id: number) => ({ name: '3D/Objects/object_1.model', data: enc(`${head('')}<resources><object id="${id}" type="model"><mesh>${tet}</mesh></object></resources></model>`) })
    // the production-extension shape: an assembly in the root file whose components live in a sub-model, placed with transforms
    const root = `${head(' requiredextensions="p"')}<resources><object id="3" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object></resources><build><item objectid="3"/></build></model>`
    const r = await read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(root) }, sub(1)]))
    expect(r.mesh.indices.length / 3).toBe(8)
    expect(Math.max(...Array.from(r.mesh.positions).filter((_, i) => i % 3 === 0))).toBeCloseTo(11)
    // an item may point at a sub-model object directly
    const root2 = `${head(' requiredextensions="p"')}<resources/><build><item p:path="/3D/Objects/object_1.model" objectid="1"/></build></model>`
    expect((await read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(root2) }, sub(1)]))).mesh.indices.length / 3).toBe(4)
    // unsafe path, a build section in a sub-model, a missing object, and other required extensions are refused
    const evil = root.replace(/\/3D\/Objects\/object_1.model/g, '/3D/../x.model')
    await expect(read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(evil) }]))).rejects.toMatchObject({ params: { reason: 'unsafe_part_path' } })
    const withBuild = { name: '3D/Objects/object_1.model', data: enc(`${head('')}<resources><object id="1"><mesh>${tet}</mesh></object></resources><build><item objectid="1"/></build></model>`) }
    await expect(read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(root) }, withBuild]))).rejects.toMatchObject({ params: { reason: 'build_in_sub_model' } })
    await expect(read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(root) }, sub(7)]))).rejects.toMatchObject({ params: { reason: 'component_refers_to_missing_object' } })
    await expect(read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(root.replace('requiredextensions="p"', 'requiredextensions="p m"')) }, sub(1)]))).rejects.toMatchObject({ params: { reason: 'required_extension_not_supported' } })
  })
  it('stops a component loop that runs through sub-models', async () => {
    const enc = (t: string) => new TextEncoder().encode(t)
    const h = '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">'
    const rels = { name: '_rels/.rels', data: enc('<Relationships xmlns="x"><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') }
    const a = `${h}<resources><object id="1"><components><component p:path="/3D/b.model" objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`
    const b = `${h}<resources><object id="1"><components><component p:path="/3D/3dmodel.model" objectid="1"/></components></object></resources></model>`
    await expect(read3mf(writeZip([rels, { name: '3D/3dmodel.model', data: enc(a) }, { name: '3D/b.model', data: enc(b) }]))).rejects.toMatchObject({ params: { reason: 'components_too_deep' } })
  })
  it('a cylinder and a sphere survive the trip', async () => {
    for (const m of [cylinderMesh(5, 10, 32), sphereMesh(5, 2)]) { const b = await read3mf(write3mf(m).bytes); sameShape(m, b.mesh) }
  })
})
