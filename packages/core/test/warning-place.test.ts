import { describe, expect, it } from 'vitest'
import { MAX_WHERE_POINTS, Registry, addStep, cleanPlace, cleanWarnings, emptyStepList, makeStep, runWorkflow } from '../src'
import type { Manifest, PluginEntry } from '../src'
import { boxMesh } from '../src/testing'

describe('where a warning happened', () => {
  it('keeps finite points and triangles that exist, and drops the rest', () => {
    expect(cleanPlace({ points: [[1, 2, 3], [NaN, 0, 0], [1, 2], 'x'], triangles: [0, 4, 5, -1, 1.5, 2] }, 5)).toEqual({ points: [[1, 2, 3]], triangles: [0, 4, 2] })
    expect(cleanPlace({ points: [], triangles: [9] }, 5)).toBeUndefined()
    expect(cleanPlace('nope', 5)).toBeUndefined()
    expect(cleanPlace(null, 5)).toBeUndefined()
  })
  it('caps the number of points', () => {
    const pts = Array.from({ length: 500 }, (_, i) => [i, 0, 0])
    expect(cleanPlace({ points: pts }, 1)?.points?.length).toBe(MAX_WHERE_POINTS)
  })
  it('cleans a list of warnings: a bad place goes, the warning stays', () => {
    const out = cleanWarnings([{ code: 'a.b', where: { triangles: [99] } }, { code: 'c.d', params: { n: 1 }, where: { triangles: [1] } }, { code: 'e.f' }], 3)!
    expect(out[0]).toEqual({ code: 'a.b' })
    expect(out[1]).toEqual({ code: 'c.d', params: { n: 1 }, where: { triangles: [1] } })
    expect(out[2]).toEqual({ code: 'e.f' })
    expect(cleanWarnings(undefined, 3)).toBeUndefined()
  })
  it('reaches the result of a run: kept when it is right, dropped when the plugin names a triangle that is not there', async () => {
    const manifest: Manifest = { manifest_version: 1, id: 'com.example.warn', name: 'Warn', version: '1.0.0', license: 'MIT', description: 'Warns with a place.',
      operations: [{ id: 'warn', title: 'Warn', kind: 'modifier', category: 'check', params: [] }] } as unknown as Manifest
    const entry = { manifest, load: async () => ({ run: async (_op: string, ctx: { mesh?: unknown }) => ({ mesh: ctx.mesh, warnings: [{ code: 'x.fine', where: { points: [[1, 2, 3]], triangles: [0, 1] } }, { code: 'x.bad', where: { triangles: [100000] } }] }) }) } as unknown as PluginEntry
    const reg = new Registry().register(entry)
    const r = await runWorkflow(addStep(emptyStepList(), makeStep({ id: 'w', plugin: { id: manifest.id, version: '1.0.0' }, op: 'warn', params: {} })), { registry: reg, source: boxMesh(10, 10, 10) })
    const w = r.results[0]!.warnings!
    expect(w[0]!.where).toEqual({ points: [[1, 2, 3]], triangles: [0, 1] })
    expect(w[1]!.where).toBeUndefined()
  })
})
