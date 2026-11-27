// A manifest and a fake plugin shaped like a surface-texture tool (a displacement operation with an image, projections, masks, layers and
// its own limits). It shows that the manifest, the validator, the JSON schema, the cache and the runner can carry such a plugin, before any
// real one is written.
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { MeshError, Registry, checkValue, addStep, clampParam, emptyStepList, makeStep, manifestSchemas, runWorkflow, validateManifest, validateParams } from '../src'
import type { Manifest, Mesh, Operation, ParamDef } from '../src'
import { boxMesh } from '../src/testing'

const layerFields = [
  { name: 'texture', type: 'asset', default: null, accept: ['image/png', 'image/jpeg'], library: 'textures', widget: 'gallery', allow_upload: true, categories: ['stone', 'wood'], searchable: true, personalisable: true },
  { name: 'projection', type: 'enum', default: 'triplanar', options: ['planar_z', 'cylindrical', 'spherical', 'triplanar', 'cubic'] },
  { name: 'amplitude', type: 'float', default: 0.5, min: 0, max: 5, unit: 'mm', personalisable: true },
  { name: 'mask', type: 'selection', default: null },
] as const

const displace: Operation = {
  id: 'displace', title: 'Surface texture', kind: 'modifier', personalisable: 'optional', stages: ['subdivide', 'displace', 'decimate'],
  outputs: { mesh: true, report: true, closed: true },
  limits: { max_input_triangles: 1000, max_output_triangles: 5000, max_memory_mb: 50 },
  params: [
    { name: 'texture', type: 'asset', default: null, accept: ['image/png', 'image/jpeg'], library: 'textures', widget: 'gallery', allow_upload: true, categories: ['stone', 'wood'], searchable: true, personalisable: true },
    { name: 'projection', type: 'enum', default: 'triplanar', options: ['planar_z', 'cylindrical', 'spherical', 'triplanar', 'cubic'] },
    { name: 'tile_size', type: 'float', default: 10, min: 0.5, max: 200, scale: 'log', unit: 'mm', personalisable: true },
    { name: 'amplitude', type: 'float', default: 0.5, min: 0, max: 5, unit: 'mm', personalisable: true },
    { name: 'rotation', type: 'angle', default: 0, min: -180, max: 180, personalisable: true },
    { name: 'offset', type: 'vector', size: 2, default: [0, 0], min: -1000, max: 1000, personalisable: true },
    { name: 'invert', type: 'bool', default: false, personalisable: true },
    { name: 'angle_band', type: 'range', default: [0, 90], min: 0, max: 90, step: 1 },
    { name: 'only_on', type: 'part', default: '' },
    { name: 'mask', type: 'selection', default: null },
    { name: 'layers', type: 'list', default: [], item: layerFields as unknown as ParamDef[], min_items: 0, max_items: 4, item_label: 'Layer' },
    { name: 'refine_length', type: 'float', default: 1, min: 0.1, max: 5, unit: 'mm' },
    { name: 'max_triangles', type: 'int', default: 750000, min: 1000, max: 8000000 },
  ] as unknown as ParamDef[],
}
const manifest: Manifest = { manifest_version: 1, id: 'test.texture', name: 'Texture', version: '1.0.0', operations: [displace] }

describe('a texture-style manifest', () => {
  it('is valid, and its parts are checked', () => {
    expect(validateManifest(manifest).ok).toBe(true)
    const bad = (patch: (o: Operation) => void): string[] => { const m = JSON.parse(JSON.stringify(manifest)) as Manifest; patch(m.operations[0] as Operation); return validateManifest(m).errors.map(e => String(e.params?.['reason'])) }
    expect(bad(o => { (o.params.find(p => p.name === 'layers') as unknown as { item: unknown[] }).item = [] })).toContain('no_list_item')
    expect(bad(o => { (o.params.find(p => p.name === 'layers') as unknown as { item: unknown[] }).item.push({ name: 'inner', type: 'list', default: [], item: [{ name: 'x', type: 'bool', default: false }] }) })).toContain('bad_item_type')
    // a row may hold a placement (several clicked points); a list in a list is still refused
    expect(bad(o => { (o.params.find(p => p.name === 'layers') as unknown as { item: unknown[] }).item.push({ name: 'at', type: 'placement', default: null }) })).not.toContain('bad_item_type')
    expect(bad(o => { o.limits = { max_input_triangles: -1 } })).toContain('bad_limits')
    expect(bad(o => { (o.params.find(p => p.name === 'angle_band') as unknown as { default: unknown }).default = [80, 10] })).toContain('bad_default')
    expect(bad(o => { (o.params.find(p => p.name === 'texture') as unknown as { categories: unknown }).categories = 'stone' })).toContain('bad_categories')
  })

  it('validates values: range, list rows, selection runs', () => {
    const ok = (v: Record<string, unknown>): string[] => validateParams(displace, v).errors.map(e => `${e.code}${e.params?.['field'] ? `:${String(e.params['field'])}` : ''}`)
    expect(ok({ angle_band: [10, 80], layers: [{ texture: 'a', amplitude: 1 }], mask: { mode: 'include', triangles: [[0, 5], [10, 2]], basis: 'abc' } })).toEqual([])
    expect(ok({ angle_band: [80, 10] })).toEqual(['param.invalid:low_above_high'])
    expect(ok({ angle_band: [-5, 10] })).toEqual(['param.out_of_range'])
    expect(ok({ layers: Array.from({ length: 5 }, () => ({})) })).toEqual(['param.too_many_items'])
    expect(ok({ layers: [{ amplitude: 99 }] })).toEqual(['param.out_of_range:amplitude'])
    expect(ok({ layers: [{ nope: 1 }] })).toEqual(['param.unknown'])
    expect(ok({ mask: { mode: 'include', triangles: [[5, 3], [6, 2]] } })).toEqual(['param.invalid:triangles'])      // overlapping runs
    expect(ok({ mask: { mode: 'both', triangles: [] } })).toEqual(['param.invalid:mode'])
  })

  it('clamps what the panel would send: ranges are ordered, list rows get their defaults', () => {
    const band = displace.params.find(p => p.name === 'angle_band') as ParamDef, layers = displace.params.find(p => p.name === 'layers') as ParamDef
    expect(clampParam(band, [95, -4])).toEqual([0, 90])
    expect(clampParam(band, [60, 30])).toEqual([30, 60])
    expect(clampParam(layers, [{ amplitude: 50 }, 'junk'])).toEqual([
      { texture: null, projection: 'triplanar', amplitude: 5, mask: null },
      { texture: null, projection: 'triplanar', amplitude: 0.5, mask: null },
    ])
  })

  it('exports a JSON schema a standard validator agrees with', () => {
    const schema = manifestSchemas(manifest)['displace'] as object
    const ajv = new Ajv2020({ strict: false }), check = ajv.compile(schema)
    const good = { amplitude: 1, angle_band: [10, 80], layers: [{ texture: 'a', amplitude: 1 }], mask: null }
    expect(check(good)).toBe(true)
    for (const bad of [{ angle_band: [1] }, { layers: Array.from({ length: 5 }, () => ({})) }, { layers: [{ amplitude: 99 }] }, { mask: { mode: 'x', triangles: [] } }, { surprise: 1 }]) expect(check(bad), JSON.stringify(bad)).toBe(false)
  })

  it('the customer role may change the texture and amplitude only, never the designer-only fields', () => {
    const base = { ...Object.fromEntries(displace.params.map(p => [p.name, p.default])) }
    const customer = (v: Record<string, unknown>): string[] => validateParams(displace, { ...base, ...v }, { role: 'customer', base, personalisableParams: ['texture', 'amplitude'] }).errors.map(e => `${e.code}:${String(e.params?.['name'])}`)
    expect(customer({ texture: 'granite', amplitude: 2 })).toEqual([])
    expect(customer({ refine_length: 0.2 })).toEqual(['param.not_editable:refine_length'])
    expect(customer({ tile_size: 20 })).toEqual(['param.not_editable:tile_size'])
  })
})

// ---------------------------------------------------------------------------------------------------- the engine around it

function fakeRegistry(run: (mesh: Mesh, params: Record<string, unknown>) => Mesh, assetsSeen: string[] = []): Registry {
  return new Registry().register({
    manifest,
    load: () => ({ run: async (_op, ctx) => { assetsSeen.push(String(ctx.params['texture'])); return { mesh: run(ctx.mesh as Mesh, ctx.params) } } }),
  })
}
const listOf = (params: Record<string, unknown>) => addStep(emptyStepList(), makeStep({ id: 'd', plugin: { id: 'test.texture', version: '1.0.0' }, op: 'displace', params }))

describe('the engine around a texture-style plugin', () => {
  it('a replaced texture under the same id gives a fresh result, not a stale cached one', async () => {
    let calls = 0
    const reg = fakeRegistry(m => { calls++; return m })
    const cache = new (await import('../src')).MemoryCache()
    let bytes = new Uint8Array([1, 2, 3])
    const opts = { registry: reg, source: boxMesh(10, 10, 10), cache, assets: async () => bytes }
    const l = listOf({ texture: 'granite' })
    const first = await runWorkflow(l, opts); await runWorkflow(l, opts)
    expect(first.results[0]?.error, JSON.stringify(first.results[0]?.error)).toBeUndefined()
    expect(calls).toBe(1)                                   // the same content: from the cache
    bytes = new Uint8Array([9, 9, 9])
    await runWorkflow(l, opts)
    expect(calls).toBe(2)                                   // another file under the same id: runs again
    // a host that already knows a content hash can give it, and the bytes are not read for the key
    let reads = 0
    const o2 = { registry: reg, source: boxMesh(10, 10, 10), cache: new (await import('../src')).MemoryCache(), assets: async () => { reads++; return bytes }, assetKey: () => 'sha:fixed' }
    await runWorkflow(l, o2); await runWorkflow(l, o2)
    expect(calls).toBe(3); expect(reads).toBe(0)           // the key came from the host's hash: the bytes were not read (this fake plugin never reads them)
  })

  it("the operation's own limits stop a mesh that is too big going in, or too big coming out", async () => {
    const big = (n: number): Mesh => ({ positions: new Float64Array(9 * n), indices: Uint32Array.from({ length: 3 * n }, (_, i) => i) })
    const tooBigIn = await runWorkflow(listOf({}), { registry: fakeRegistry(m => m), source: big(1500) })
    expect(tooBigIn.results[0]?.error).toMatchObject({ code: 'budget.triangles', params: { of: 'input', max: 1000, op: 'displace' } })
    const tooBigOut = await runWorkflow(listOf({}), { registry: fakeRegistry(() => big(6000)), source: boxMesh(10, 10, 10) })
    expect(tooBigOut.results[0]?.error).toMatchObject({ code: 'budget.triangles', params: { of: 'result', max: 5000 } })
    const memory = await runWorkflow(listOf({}), { registry: fakeRegistry(m => m), source: big(900) })     // 900 triangles are about 0.1 MiB, fine
    expect(memory.ok).toBe(true)
  })

  it('a plugin that promises a closed result must deliver one when it received one', async () => {
    const open = (m: Mesh): Mesh => ({ ...m, indices: m.indices.slice(0, m.indices.length - 3) })          // drop one triangle: a hole
    const r = await runWorkflow(listOf({}), { registry: fakeRegistry(open), source: boxMesh(10, 10, 10) })
    expect(r.results[0]?.error).toMatchObject({ code: 'plugin.bad_mesh', params: { problem: 'not_closed' } })
    const fine = await runWorkflow(listOf({}), { registry: fakeRegistry(m => m), source: boxMesh(10, 10, 10) })
    expect(fine.ok).toBe(true)
    // an open input is not blamed on the plugin
    const openIn = await runWorkflow(listOf({}), { registry: fakeRegistry(m => m), source: open(boxMesh(10, 10, 10)) })
    expect(openIn.ok).toBe(true)
    void MeshError
  })
})

describe('colours and objects', () => {
  const op: Operation = { id: 'paint', kind: 'modifier', params: [
    { name: 'tint', type: 'color', default: '#ff8800' },
    { name: 'glow', type: 'color', default: '#00ff0080', alpha: true },
    { name: 'filament', type: 'color', default: '#d9534f', palette: ['#D9534F', '#4C78A8'], only_palette: true },
    { name: 'outline', type: 'object', default: { width: 1, color: '#000000' }, fields: [
      { name: 'width', type: 'float', default: 1, min: 0, max: 5 },
      { name: 'color', type: 'color', default: '#000000' },
    ] },
    { name: 'layers', type: 'list', default: [], item: [{ name: 'tint', type: 'color', default: '#ffffff' }, { name: 'edge', type: 'object', default: { w: 1 }, fields: [{ name: 'w', type: 'float', default: 1, min: 0, max: 3 }] }] },
  ] as unknown as ParamDef[] }
  const m: Manifest = { manifest_version: 1, id: 'test.paint', name: 'Paint', version: '1.0.0', operations: [op] }
  const codes = (v: Record<string, unknown>): string[] => validateParams(op, v).errors.map(e => `${e.code}${e.params?.['field'] ? `:${String(e.params['field'])}` : ''}`)

  it('the manifest accepts them and refuses a broken definition', () => {
    expect(validateManifest(m).ok).toBe(true)
    const bad = (name: string, patch: (p: Record<string, unknown>) => void): string[] => { const c = JSON.parse(JSON.stringify(m)) as Manifest; patch((c.operations[0] as Operation).params.find(p => p.name === name) as unknown as Record<string, unknown>); return validateManifest(c).errors.map(e => String(e.params?.['reason'])) }
    expect(bad('filament', p => { p['palette'] = ['red'] })).toContain('bad_palette')
    expect(bad('filament', p => { delete p['palette'] })).toContain('only_palette_without_palette')
    expect(bad('outline', p => { (p['fields'] as unknown[]).push({ name: 'inner', type: 'object', default: {}, fields: [{ name: 'x', type: 'bool', default: false }] }) })).toContain('bad_item_type')
    expect(bad('outline', p => { p['fields'] = [] })).toContain('no_object_fields')
  })
  it('validates colours (with and without alpha, and a palette) and groups', () => {
    expect(codes({ tint: '#AABBCC', glow: '#aabbcc', outline: { width: 2 } })).toEqual([])
    expect(codes({ glow: '#aabbccdd' })).toEqual([])
    expect(codes({ tint: '#aabbccdd' })).toEqual(['param.pattern'])      // alpha is not allowed here
    expect(codes({ tint: 'orange' })).toEqual(['param.pattern'])
    expect(codes({ filament: '#4c78a8' })).toEqual([])                   // the palette, in any case
    expect(codes({ filament: '#123456' })).toEqual(['param.not_enum'])
    expect(codes({ outline: { width: 9 } })).toEqual(['param.out_of_range:width'])
    expect(codes({ outline: { colour: '#000000' } })).toEqual(['param.unknown'])
    expect(codes({ layers: [{ tint: '#000000', edge: { w: 2 } }] })).toEqual([])
    expect(codes({ layers: [{ edge: { w: 5 } }] })).toEqual(['param.out_of_range:edge.w'])
  })
  it('clamps: colours become lower case, a bad one the default; groups get their defaults', () => {
    const p = (n: string): ParamDef => op.params.find(x => x.name === n) as ParamDef
    expect(clampParam(p('tint'), '#AABBCC')).toBe('#aabbcc')
    expect(clampParam(p('tint'), 'nope')).toBe('#ff8800')
    expect(clampParam(p('filament'), '#123456')).toBe('#d9534f')
    expect(clampParam(p('outline'), { width: 99 })).toEqual({ width: 5, color: '#000000' })
  })
  it('the JSON schema agrees, including the palette in either case', () => {
    const check = new Ajv2020({ strict: false }).compile(manifestSchemas(m)['paint'] as object)
    expect(check({ tint: '#aabbcc', filament: '#4C78A8', outline: { width: 2, color: '#000000' } })).toBe(true)
    for (const bad of [{ tint: 'red' }, { filament: '#123456' }, { outline: { width: 9 } }, { outline: { extra: 1 } }]) expect(check(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('groups: the distinct parts of a mesh', () => {
  const op: Operation = { id: 'part', kind: 'modifier', params: [{ name: 'only', type: 'part', kinds: ['group'], default: '' }, { name: 'which', type: 'part', kinds: ['group'], default: 'body_a', allow_empty: false }] as unknown as ParamDef[] }
  const mesh = (): Mesh => ({
    positions: new Float64Array(9 * 5), indices: Uint32Array.from({ length: 15 }, (_, i) => i),
    groups: [{ start: 0, count: 2, role: 'solid', name: 'body_a' }, { start: 2, count: 1, role: 'negative' }, { start: 3, count: 2, role: 'solid', name: 'lid' }],
  })
  it('a group parameter is a name; empty means all parts unless the definition says otherwise', () => {
    const codes = (v: Record<string, unknown>): string[] => validateParams(op, v).errors.map(e => e.code)
    expect(codes({ only: 'lid', which: 'body_a' })).toEqual([])
    expect(codes({ only: '' })).toEqual([])
    expect(codes({ which: '' })).toEqual(['param.pattern'])
    expect(codes({ only: 'Part 6' })).toEqual([])                                   // bodies keep the names of their file
    expect(codes({ only: 'Lid (left)' })).toEqual([])
    expect(codes({ only: 'x'.repeat(121) })).toEqual(['param.pattern'])
    expect(codes({ only: 3 })).toEqual(['param.type'])
  })
  it('finds a group by name (an unnamed one is part_2 by position), flags its triangles, and refuses an unknown name', async () => {
    const { groupNames, groupRange, selectGroupTriangles } = await import('../src')
    expect(groupNames(mesh())).toEqual(['body_a', 'part_2', 'lid'])
    expect(groupRange(mesh(), 'part_2')).toEqual({ start: 2, count: 1, role: 'negative' })
    expect(Array.from(selectGroupTriangles(mesh(), 'lid') as Uint8Array)).toEqual([0, 0, 0, 1, 1])
    expect(selectGroupTriangles(mesh(), '')).toBeNull()
    expect(() => selectGroupTriangles(mesh(), 'base')).toThrowError(expect.objectContaining({ code: 'group.unknown', params: expect.objectContaining({ known: ['body_a', 'part_2', 'lid'] }) as unknown }))
  })
  it('the JSON schema says the same as the validator', () => {
    const m: Manifest = { manifest_version: 1, id: 'test.part', name: 'Part', version: '1.0.0', operations: [op] }
    const check = new Ajv2020({ strict: false }).compile(manifestSchemas(m)['part'] as object)
    expect(check({ only: 'lid', which: 'body_a' })).toBe(true)
    expect(check({ only: 'Part 6' })).toBe(true)
    expect(check({ only: 'x'.repeat(121) })).toBe(false)
    expect(check({ which: '' })).toBe(false)
  })
})

describe('parts: a segment or a group, one parameter', () => {
  const mesh = (): Mesh => ({
    positions: new Float64Array(9 * 5), indices: Uint32Array.from({ length: 15 }, (_, i) => i),
    groups: [{ start: 0, count: 3, role: 'solid', name: 'base' }, { start: 3, count: 2, role: 'solid', name: 'lid' }],
    segments: { labels: Uint16Array.from([0, 0, 1, 2, 2]), table: [{ id: 0, name: 'body' }, { id: 1, name: 'text' }, { id: 2, name: 'lid' }] },
  })
  const both: ParamDef = { name: 'p', type: 'part', default: '' } as ParamDef
  const segOnly: ParamDef = { name: 'p', type: 'part', kinds: ['segment'], default: '' } as ParamDef
  it('validates the plain name, and the prefix only when both kinds are allowed', () => {
    expect(checkValue(both, 'text')).toBeNull(); expect(checkValue(both, 'group:lid')).toBeNull(); expect(checkValue(both, 'segment:lid')).toBeNull(); expect(checkValue(both, '')).toBeNull()
    expect(checkValue(both, 'thing:lid')?.code).toBe('param.pattern')
    expect(checkValue(segOnly, 'text')).toBeNull(); expect(checkValue(segOnly, 'group:lid')?.code).toBe('param.pattern')
  })
  it('lists the parts, writes a prefix for a shared name, and selects the right triangles', async () => {
    const { partList, partValue, selectPart } = await import('../src')
    expect(partList(mesh()).map(r => `${r.kind}:${r.name}`)).toEqual(['segment:text', 'segment:lid', 'group:base', 'group:lid'])
    expect(partValue(mesh(), { kind: 'group', name: 'lid' })).toBe('group:lid'); expect(partValue(mesh(), { kind: 'segment', name: 'text' })).toBe('text')
    expect(Array.from(selectPart(mesh(), 'text') as Uint8Array)).toEqual([0, 0, 1, 0, 0])
    expect(Array.from(selectPart(mesh(), 'base') as Uint8Array)).toEqual([1, 1, 1, 0, 0])
    expect(Array.from(selectPart(mesh(), 'segment:lid') as Uint8Array)).toEqual([0, 0, 0, 1, 1])
    expect(selectPart(mesh(), '')).toBeNull()
    expect(() => selectPart(mesh(), 'lid')).toThrowError(expect.objectContaining({ code: 'part.ambiguous' }))      // both a segment and a group
    expect(() => selectPart(mesh(), 'nothing')).toThrowError(expect.objectContaining({ code: 'part.unknown' }))
    expect(() => selectPart(mesh(), 'lid', ['segment'])).not.toThrow()                                              // one kind allowed: no ambiguity
    expect(() => selectPart(mesh(), 'base', ['segment'])).toThrowError(expect.objectContaining({ code: 'segment.unknown' }))
    expect(() => selectPart(mesh(), 'group:lid', ['segment'])).toThrowError(expect.objectContaining({ code: 'group.unknown' }))
  })
})

describe('which parts exist after each step (from the manifests alone)', () => {
  const manifestOf = (): Manifest => ({ manifest_version: 1, id: 'test.flow', name: 'Flow', version: '1.0.0', operations: [
    { id: 'make', kind: 'modifier', outputs: { mesh: true, segments: [{ param: 'name' }, 'edge'] }, params: [{ name: 'name', type: 'part', kinds: ['segment'], default: 'text' }] },
    { id: 'use', kind: 'modifier', params: [{ name: 'only', type: 'part', default: '' }] },
    { id: 'weld', kind: 'modifier', outputs: { mesh: true, drops: ['segments'] }, params: [] },
  ] as unknown as Operation[] })
  const reg = new Registry().register({ manifest: manifestOf(), load: () => ({ run: () => ({}) }) })
  const step = (id: string, op: string, params: Record<string, unknown> = {}, enabled = true) => makeStep({ id, plugin: { id: 'test.flow', version: '1.0.0' }, op, params, enabled })
  const list = (...s: ReturnType<typeof step>[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
  it('a part made earlier can be used; one nobody makes is flagged when the file is known', async () => {
    const { checkPartReferences } = await import('../src')
    expect(checkPartReferences(list(step('a', 'make', { name: 'letters' }), step('b', 'use', { only: 'letters' }), step('c', 'use', { only: 'edge' })), reg, { segments: [], groups: [] })).toEqual([])
    expect(checkPartReferences(list(step('b', 'use', { only: 'letters' })), reg, { segments: [], groups: [] })).toEqual([{ stepId: 'b', param: 'only', value: 'letters', code: 'part.not_produced' }])
    expect(checkPartReferences(list(step('b', 'use', { only: 'lid' })), reg, { segments: [], groups: ['lid'] })).toEqual([])      // it is in the file
    expect(checkPartReferences(list(step('b', 'use', { only: 'group:lid' })), reg, { segments: ['lid'], groups: [] })).toHaveLength(1)   // the prefix says group
    expect(checkPartReferences(list(step('b', 'use', { only: 'letters' })), reg)).toEqual([])                                       // file unknown: cannot judge
  })
  it('a step that drops segments makes later references say so; a disabled step changes nothing', async () => {
    const { checkPartReferences } = await import('../src')
    const l = list(step('a', 'make', { name: 'letters' }), step('w', 'weld'), step('b', 'use', { only: 'letters' }))
    expect(checkPartReferences(l, reg)).toEqual([{ stepId: 'b', param: 'only', value: 'letters', code: 'part.dropped' }])
    expect(checkPartReferences(list(step('a', 'make', { name: 'letters' }), step('w', 'weld', {}, false), step('b', 'use', { only: 'letters' })), reg)).toEqual([])
    // making it again after the drop brings it back
    expect(checkPartReferences(list(step('a', 'make', { name: 'letters' }), step('w', 'weld'), step('a2', 'make', { name: 'letters' }), step('b', 'use', { only: 'letters' })), reg)).toEqual([])
  })
  it('the manifest checks the new output fields', () => {
    const bad = (patch: (o: Record<string, unknown>) => void): boolean => { const m = JSON.parse(JSON.stringify(manifestOf())) as Manifest; patch((m.operations[0] as unknown as { outputs: Record<string, unknown> }).outputs); return validateManifest(m).ok }
    expect(bad(() => undefined)).toBe(true)
    expect(bad(o => { o['segments'] = ['Not A Name'] })).toBe(false)
    expect(bad(o => { o['drops'] = ['everything'] })).toBe(false)
  })
})

describe('a step that drops the part its parameter names', () => {
  const manifestOf = (): Manifest => ({ manifest_version: 1, id: 'test.drop', name: 'Drop', version: '1.0.0', operations: [
    { id: 'drop', kind: 'modifier', outputs: { mesh: true, drops: [{ param: 'part' }] }, params: [{ name: 'part', type: 'part', kinds: ['group', 'segment'], default: '' }] },
    { id: 'only', kind: 'modifier', outputs: { mesh: true, drops: [{ param: 'part', keep: true }] }, params: [{ name: 'part', type: 'part', kinds: ['group', 'segment'], default: '' }] },
    { id: 'use', kind: 'modifier', params: [{ name: 'part', type: 'part', default: '' }] },
  ] as unknown as Operation[] })
  const reg = new Registry().register({ manifest: manifestOf(), load: () => ({ run: () => ({}) }) })
  const step = (id: string, op: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: 'test.drop', version: '1.0.0' }, op, params })
  const list = (...s: ReturnType<typeof step>[]) => s.reduce((l, x) => addStep(l, x), emptyStepList())
  const base = { segments: ['lid', 'rim'], groups: ['left', 'right'] }
  it('the named part is gone afterwards, the others stay', async () => {
    const { checkPartReferences } = await import('../src')
    expect(checkPartReferences(list(step('d', 'drop', { part: 'lid' }), step('u', 'use', { part: 'lid' })), reg, base)).toEqual([{ stepId: 'u', param: 'part', value: 'lid', code: 'part.dropped' }])
    expect(checkPartReferences(list(step('d', 'drop', { part: 'lid' }), step('u', 'use', { part: 'rim' })), reg, base)).toEqual([])
    expect(checkPartReferences(list(step('d', 'drop', { part: 'segment:lid' }), step('u', 'use', { part: 'left' })), reg, base)).toEqual([])
  })
  it('keep: every other part of the kind is gone', async () => {
    const { checkPartReferences } = await import('../src')
    expect(checkPartReferences(list(step('k', 'only', { part: 'left' }), step('u', 'use', { part: 'right' })), reg, base)).toEqual([{ stepId: 'u', param: 'part', value: 'right', code: 'part.dropped' }])
    expect(checkPartReferences(list(step('k', 'only', { part: 'left' }), step('u', 'use', { part: 'left' })), reg, base)).toEqual([])
    expect(checkPartReferences(list(step('k', 'only', { part: 'left' }), step('u', 'use', { part: 'lid' })), reg, base)).toEqual([])   // segments are not known to be affected
  })
  it('an empty value drops nothing, and the manifest checks the new form', () => {
    const bad = (patch: (o: Record<string, unknown>) => void): boolean => { const m = JSON.parse(JSON.stringify(manifestOf())) as Manifest; patch((m.operations[0] as unknown as { outputs: Record<string, unknown> }).outputs); return validateManifest(m).ok }
    expect(bad(() => undefined)).toBe(true)
    expect(bad(o => { o['drops'] = [{ param: 'part', keep: 'yes' }] })).toBe(false)
    expect(bad(o => { o['drops'] = [{ nope: 1 }] })).toBe(false)
  })
})
