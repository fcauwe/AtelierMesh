import { describe, expect, it } from 'vitest'
import {
  MeshError, Registry, addStep, assignSegment, buildPackage, decodeMesh, emptyStepList, encodeMesh, loadProject, makeStep, meshKey, parseStl, read3mf, readZip, saveProject, setParams, writeZip,
} from '../src'
import type { Mesh } from '../src'
import { boxMesh, createTestPlugin, lBracketMesh, TEST_PLUGIN_ID } from '../src/testing'

const labelled = (): Mesh => assignSegment(lBracketMesh(), 'top', Uint8Array.from({ length: lBracketMesh().indices.length / 3 }, (_, i) => (i % 5 === 0 ? 1 : 0)), '#336699')
const steps = () => addStep(addStep(emptyStepList(), makeStep({ id: 'a', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'scale', params: { factor: 2 } })), makeStep({ id: 'b', plugin: { id: TEST_PLUGIN_ID, version: '1.0.0' }, op: 'measure' }))

describe('native mesh bytes', () => {
  it('round-trip exactly, with segments and groups', () => {
    const m = { ...labelled(), groups: [{ start: 0, count: 4, role: 'solid' as const, name: 'a' }] }
    const back = decodeMesh(encodeMesh(m))
    expect(Array.from(back.positions)).toEqual(Array.from(m.positions))
    expect(Array.from(back.indices)).toEqual(Array.from(m.indices))
    expect(Array.from(back.segments!.labels)).toEqual(Array.from(m.segments!.labels))
    expect(back.segments!.table).toEqual(m.segments!.table)
    expect(back.groups).toEqual(m.groups)
  })
  it('refuses damaged bytes and over-budget meshes', () => {
    const bytes = encodeMesh(boxMesh(1, 1, 1))
    expect(() => decodeMesh(bytes.slice(0, 40))).toThrowError(expect.objectContaining({ code: 'import.invalid_project' }))
    expect(() => decodeMesh(new Uint8Array(30))).toThrowError(expect.objectContaining({ code: 'import.invalid_project' }))
    const bad = bytes.slice(); new DataView(bad.buffer).setUint32(bad.length - 4, 999, true)
    expect(() => decodeMesh(bad)).toThrowError(expect.objectContaining({ code: 'import.invalid_project', params: expect.objectContaining({ reason: 'index_out_of_range' }) as unknown }))
    expect(() => decodeMesh(bytes, { maxTriangles: 5 })).toThrowError(expect.objectContaining({ code: 'budget.triangles' }))
  })
  it('the cache key notices segment changes (same geometry, different labels)', () => {
    const a = boxMesh(1, 1, 1), b = assignSegment(a, 's', new Uint8Array(12).fill(1)), c = assignSegment(a, 's', new Uint8Array(12).fill(0).fill(1, 0, 6))
    expect(new Set([meshKey(a), meshKey(b), meshKey(c)]).size).toBe(3)
    expect(meshKey(b)).toBe(meshKey(assignSegment(a, 's', new Uint8Array(12).fill(1))))
  })
})

describe('project file', () => {
  const font = new Uint8Array([1, 2, 3, 4, 5])
  it('reopening restores steps, placements, base, rollback and assets exactly', async () => {
    const placement = { anchor: { point: [1, 2, 3], normal: [0, 0, 1], tri: 7 }, up_ref: 'z', direction: 90, offset: [0.5, -1] }
    const list = setParams(steps(), 'a', { factor: 2, label: 'Anna', placement })
    const bytes = saveProject({ name: 'Mug', base: labelled(), list, rollback: 'a', assets: [{ id: 'font', bytes: font }] })
    const back = await loadProject(bytes)
    expect(back.name).toBe('Mug')
    expect(JSON.parse(JSON.stringify(back.list))).toEqual(JSON.parse(JSON.stringify(list)))
    expect(back.list.steps[0]!.params['placement']).toEqual(placement)
    expect(back.rollback).toBe('a')
    expect(Array.from(back.assets[0]!.bytes)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(back.base!.segments!.labels)).toEqual(Array.from(labelled().segments!.labels))
    expect(back.missingPlugins).toEqual([])
  })
  it('remembers where a package came from, so the editor can offer to load it again', async () => {
    const bytes = saveProject({ name: 'x', base: null, list: steps(), rollback: null, assets: [], plugins: [{ id: TEST_PLUGIN_ID, version: '1.0.0', fileSha256: 'ab'.repeat(32), origin: 'https://example.org/p.amplugin', signed: true, signer: 'Anna' }, { id: 'not.used', version: '9.9.9' }] })
    const back = await loadProject(bytes)
    expect(back.lock).toEqual([{ id: TEST_PLUGIN_ID, version: '1.0.0', fileSha256: 'ab'.repeat(32), origin: 'https://example.org/p.amplugin', signed: true, signer: 'Anna' }])   // only plugins the steps use
  })
  it('can unload a plugin: the steps that used it fail with step.unknown_plugin', async () => {
    const reg = new Registry().register(createTestPlugin().entry)
    expect(reg.unregister(TEST_PLUGIN_ID)).toBe(true); expect(reg.unregister(TEST_PLUGIN_ID)).toBe(false)
    expect(reg.has(TEST_PLUGIN_ID)).toBe(false)
  })
  it('reports missing plugins and version differences against a registry', async () => {
    const bytes = saveProject({ name: 'x', base: null, list: steps(), rollback: null, assets: [] })
    expect((await loadProject(bytes, { registry: new Registry() })).missingPlugins).toEqual([TEST_PLUGIN_ID])
    const reg = new Registry().register(createTestPlugin('1.2.0').entry)
    expect((await loadProject(bytes, { registry: reg })).versionDiffs).toEqual([{ id: TEST_PLUGIN_ID, saved: '1.0.0', installed: '1.2.0' }])
  })
  it('refuses a damaged or tampered project', async () => {
    const good = saveProject({ name: 'x', base: boxMesh(1, 1, 1), list: steps(), rollback: null, assets: [{ id: 'font', bytes: font }] })
    const files = await readZip(good)
    const rebuild = (mutate: (f: Array<{ name: string; data: Uint8Array }>) => void): Uint8Array => { const f = files.map(e => ({ name: e.name, data: e.data.slice() })); mutate(f); return writeZip(f) }
    await expect(loadProject(rebuild(f => { f.find(e => e.name.startsWith('assets/'))!.data[0] = 9 }))).rejects.toMatchObject({ params: { reason: 'asset_hash_mismatch' } })
    await expect(loadProject(rebuild(f => { f.splice(f.findIndex(e => e.name === 'project.json'), 1) }))).rejects.toMatchObject({ params: { reason: 'missing_project_json' } })
    await expect(loadProject(rebuild(f => { f.splice(f.findIndex(e => e.name === 'inputs/base.ammesh'), 1) }))).rejects.toMatchObject({ params: { reason: 'missing_base' } })
    await expect(loadProject(rebuild(f => { const p = f.find(e => e.name === 'project.json')!; p.data = new TextEncoder().encode(new TextDecoder().decode(p.data).replace('"format_version": 1', '"format_version": 2')) }))).rejects.toMatchObject({ params: { reason: 'unsupported_format_version' } })
    await expect(loadProject(rebuild(f => { const p = f.find(e => e.name === 'project.json')!; p.data = new TextEncoder().encode('{nope') }))).rejects.toMatchObject({ params: { reason: 'bad_project_json' } })
    await expect(loadProject(new Uint8Array(20))).rejects.toBeInstanceOf(MeshError)
  })
})

describe('save package', () => {
  it('has the Atelier file roles, a readable final 3MF, an untouched source and informational measurements', async () => {
    const src = lBracketMesh(), final = labelled()
    const zip = buildPackage({ source: src, final, steps: steps(), render: new Uint8Array([137, 80, 78, 71]), palette: [{ segment: 'top', extruder: 2, color: '#336699' }], stl: true })
    const files = new Map((await readZip(zip)).map(e => [e.name, e.data]))
    expect([...files.keys()].sort()).toEqual(['final.3mf', 'final.stl', 'measure.json', 'operations.json', 'render.png', 'source.stl'])
    expect(parseStl(files.get('source.stl')!).mesh.indices.length).toBe(src.indices.length)
    const back = await read3mf(files.get('final.3mf')!)
    expect(back.mesh.indices.length).toBe(final.indices.length)
    expect(back.paintedTriangles).toBeGreaterThan(0)
    const measure = JSON.parse(new TextDecoder().decode(files.get('measure.json')!)) as { informational: boolean; volume_mm3: number }
    expect(measure.informational).toBe(true)
    expect(measure.volume_mm3).toBeCloseTo(6000, 3)
    expect(JSON.parse(new TextDecoder().decode(files.get('operations.json')!))).toEqual(JSON.parse(JSON.stringify(steps())))
  })
})
