import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { boxMesh, sphereMesh } from '@ateliermesh/core/testing'
import { LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION, corePlugin, lowpolyPlugin } from '../src'
import { facets } from '../src/facets/facets'
import type { FacetParams } from '../src/facets/facets'
import lowpolyRun from '../src/lowpoly-run'

const P: FacetParams = { facet_size: 15, jitter: 1.2, shift: 10, seed: 1, plain_bottom: 0, plain_top: 0, wall: 1.6, inside: 'follow',
  facet_colours: 'random', palette_size: 3, colour_1: '#d9d4c7', colour_2: '#1f2d3a', colour_3: '#a3402c', colour_4: '#7a7a7a' }

const registry = (): Registry => new Registry().register(corePlugin()).register(lowpolyPlugin())
const step = (params: Record<string, unknown>) => makeStep({ id: 'f', plugin: { id: LOWPOLY_PLUGIN_ID, version: LOWPOLY_PLUGIN_VERSION }, op: 'low_poly', params: { style: 'facets', ...params } })
const run = (mesh: Mesh, params: Record<string, unknown>) => runWorkflow(addStep(emptyStepList(), step(params)), { registry: registry(), source: mesh })

describe('Low poly, Even facets style', () => {
  it('is deterministic: the same seed gives the same facets bit for bit, another seed does not', () => {
    const m = sphereMesh(40, 5)
    const a = facets(m, P), b = facets(m, P), c = facets(m, { ...P, seed: 2 })
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions))
    expect(Array.from(a.mesh.positions)).not.toEqual(Array.from(c.mesh.positions))
  })

  it('gives each colour its own segment, and one segment for one colour', () => {
    const m = sphereMesh(40, 5)
    const named = (p: FacetParams): string[] => (facets(m, p).mesh.segments?.table ?? []).map(s => s.name).filter(n => n.startsWith('facet_'))
    expect(named(P)).toEqual(['facet_1', 'facet_2', 'facet_3'])
    expect(named({ ...P, facet_colours: 'alternating' })).toEqual(['facet_1', 'facet_2'])
    expect(named({ ...P, facet_colours: 'one' })).toEqual(['facet_1'])
  })

  it('stays a closed solid and keeps a box\'s flat top and bottom on their planes', async () => {
    const box = boxMesh(60, 60, 40)
    const r = facets(box, { ...P, jitter: 2 })
    const q = measureMesh(r.mesh)
    expect(q.watertight).toBe(true)
    const zs = Array.from({ length: r.mesh.positions.length / 3 }, (_, i) => r.mesh.positions[i * 3 + 2]!)
    const lo = Math.min(...zs), hi = Math.max(...zs)
    expect(hi - lo).toBeCloseTo(40, 6)
  })

  it('runs as the low_poly step of the plugin and reports the style', async () => {
    const r = await run(sphereMesh(40, 5), { facet_size: 12, facet_colours: 'alternating' })
    const out = r.results[0]!
    expect(out.report?.['style']).toBe('facets')
    expect(out.report?.['triangles']).toBeGreaterThan(20)
  })

  it('refuses a model that is not closed, with a lowpoly code', () => {
    const open: Mesh = { positions: Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: Uint32Array.from([0, 1, 2]) }
    expect(() => facets(open, P)).toThrowError(expect.objectContaining({ code: 'lowpoly.not_closed' }))
  })

  it('a step stored before the style existed stays the Reduce style', () => {
    expect(lowpolyRun.migrate?.('0.2.0', { triangles_mode: 'auto', detail: 0.5 }, 'low_poly')).toMatchObject({ style: 'reduce' })
  })
})
