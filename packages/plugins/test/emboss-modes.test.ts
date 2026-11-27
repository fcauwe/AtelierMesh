import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, migrateStep, runWorkflow, selectTriangles } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '../src'
import { fillArea } from '../src/emboss/shape'
import { SVG_IMPORTER_VERSION, drawingToShape, importSvg, refreshSvgDrawings, svgToDrawing, svgToShape } from '../src/emboss/svg'
import { gridBox } from './parts'

const registry = (): Registry => new Registry().register(corePlugin())
const plate = gridBox(70, 30, 4, 140, 60, 8)
const placement = { anchor: { point: [0, 0, 4], normal: [0, 0, 1] } }
const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>'

/** The SVG is imported once into a drawing in the project store (`svgToDrawing`); the step takes the drawing by name. */
async function embossSvg(params: Record<string, unknown>, svg = SQUARE, mode: 'fill' | 'line' = 'fill') {
  const l = addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss_svg', params: { placement, shape: 'art', size: 10, ...params } }))
  const r = await runWorkflow(l, { registry: registry(), source: plate, store: { art: { payload: svgToDrawing(svg, { mode }) } } })
  return r.results[0]!
}
const area = (m: Mesh, name: string): number => {
  const sel = selectTriangles(m, name) as Uint8Array
  let a = 0
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    const p = [0, 1, 2].map(k => { const i = m.indices[3 * t + k] as number; return [m.positions[3 * i] as number, m.positions[3 * i + 1] as number, m.positions[3 * i + 2] as number] })
    const u = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!], w = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!]
    a += 0.5 * Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!)
  }
  return a
}

describe('flat mode: colour without relief', () => {
  it('keeps the shape, stays a closed solid, and only labels the surface inside the outline', async () => {
    const res = await embossSvg({ mode: 'flat' })
    expect(res.status, JSON.stringify(res.error)).toBe('ok')
    const m = res.mesh!
    expect(measureMesh(m).watertight).toBe(true)
    expect(measureMesh(m).volume).toBeCloseTo(measureMesh(plate).volume, 6)
    for (let i = 2; i < m.positions.length; i += 3) expect(m.positions[i]!).toBeLessThanOrEqual(4 + 1e-9)  // nothing lifted
    expect(m.segments!.table.map(s => s.name)).toEqual(['body', 'text'])                                // no walls part
    expect(area(m, 'text')).toBeCloseTo(10 * 10, 3)                                                      // the square, 10 x 10 mm
    expect(res.report!['volume_estimate']).toBe(0)
  })
})

describe('the SVG import and the drawing the step reads', () => {
  it('turns an SVG into closed millimetre paths at its own size, with the corner at the origin', () => {
    const d = svgToDrawing(SQUARE)   // viewBox 0 0 100 100, no width: a user unit is a CSS pixel (25.4 / 96 mm)
    expect(d.kind).toBe('drawing'); expect(d.paths.length).toBe(1); expect(d.paths[0]!.closed).toBe(true)
    const xs = d.paths[0]!.points.map(p => p[0]), ys = d.paths[0]!.points.map(p => p[1])
    const side = 100 * 25.4 / 96
    expect([Math.min(...xs), Math.min(...ys)]).toEqual([0, 0])
    expect(Math.max(...xs)).toBeCloseTo(side, 9); expect(Math.max(...ys)).toBeCloseTo(side, 9)
  })
  it('reads the size from width and height with their units over the viewBox', () => {
    const bounds = (svg: string): number[] => { const d = svgToDrawing(svg); const p = d.paths.flatMap(q => q.points); return [Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))] }
    const rect = (attrs: string): string => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="100" height="50"/></svg>`
    expect(bounds(rect('width="40mm" viewBox="0 0 100 50"'))).toEqual([40, 20].map(v => expect.closeTo(v, 9)))
    expect(bounds(rect('width="2cm" height="1cm" viewBox="0 0 100 50"'))).toEqual([20, 10].map(v => expect.closeTo(v, 9)))
    expect(bounds(rect('width="1in" viewBox="0 0 100 50"'))).toEqual([25.4, 12.7].map(v => expect.closeTo(v, 9)))
    expect(bounds(rect('height="10mm" viewBox="0 0 100 50"'))).toEqual([20, 10].map(v => expect.closeTo(v, 9)))
    expect(bounds(rect('width="50%" viewBox="0 0 100 50"'))).toEqual([100 * 25.4 / 96, 50 * 25.4 / 96].map(v => expect.closeTo(v, 9)))   // a percentage means nothing here: pixels
    expect(bounds(rect('width="200" height="100"'))).toEqual([100 * 25.4 / 96, 50 * 25.4 / 96].map(v => expect.closeTo(v, 9)))   // no viewBox: user units are pixels
  })
  it('the shape from the drawing is the same as from the SVG at the same size, straight edges or curves', () => {
    for (const svg of [SQUARE, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>']) {
      const direct = svgToShape(svg, { size: 12, tolerance: 0.01 })
      const viaDrawing = drawingToShape(svgToDrawing(svg), { size: 12 })
      expect(Math.abs(fillArea(viaDrawing.rings) - fillArea(direct.rings)) / fillArea(direct.rings)).toBeLessThan(0.002)   // a circle is flattened a little finer through the drawing
      expect(viaDrawing.bbox.map(v => Math.round(v * 100) / 100)).toEqual(direct.bbox.map(v => Math.round(v * 100) / 100))
    }
  })
  it('open paths are left out, closed ones are filled by the drawing rule, and nothing closed is an error', () => {
    const closed = { points: [[0, 0], [10, 0], [10, 10], [0, 10]] as Array<[number, number]>, closed: true }
    const open = { points: [[0, 0], [20, 20]] as Array<[number, number]>, closed: false }
    const s = drawingToShape({ kind: 'drawing', paths: [closed, open] }, { size: 10 })
    expect(s.openPathsIgnored).toBe(1); expect(fillArea(s.rings)).toBeCloseTo(100, 6)
    expect(() => drawingToShape({ kind: 'drawing', paths: [open] }, { size: 10 })).toThrowError(expect.objectContaining({ code: 'emboss.empty_shape' }))
    const nested = { kind: 'drawing' as const, paths: [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]] as Array<[number, number]>, closed: true }, { points: [[3, 3], [7, 3], [7, 7], [3, 7]] as Array<[number, number]>, closed: true }] }
    expect(fillArea(drawingToShape({ ...nested, fillRule: 'evenodd' }, { size: 10 }).rings)).toBeCloseTo(100 - 16, 6)   // the inner square is a hole
  })
  it('the width limit and the anchor apply to a drawing as they did to an SVG', () => {
    const wide = { kind: 'drawing' as const, paths: [{ points: [[0, 0], [40, 0], [40, 10], [0, 10]] as Array<[number, number]>, closed: true }] }
    const s = drawingToShape(wide, { size: 10, maxWidth: 20, anchor: { h: 'left', v: 'baseline' } })
    expect(s.fitScale).toBeCloseTo(0.5, 9); expect(s.size).toBeCloseTo(5, 9); expect(s.bbox).toEqual([0, 0, 20, 5])
  })
})

describe('importing an SVG into the store: the SVG is the source of truth, the drawing is extracted and checked', () => {
  it('gives the drawing, the SVG it came from, its mode and the importer version, and measures it', () => {
    const r = importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>')
    expect(r.entry.source).toMatchObject({ kind: 'svg', mode: 'fill', importer: SVG_IMPORTER_VERSION })
    expect(r.entry.source.text).toContain('<rect')
    expect(r.entry.payload.kind).toBe('drawing')
    expect(r.stats.paths).toBe(1); expect(r.stats.points).toBe(4)
    expect(r.stats.sizeMm[0]).toBeCloseTo(40, 9); expect(r.stats.sizeMm[1]).toBeCloseTo(20, 9)
    expect(r.warnings).toEqual([])
  })
  it('says what it left out, and still gives a good drawing', () => {
    const r = importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/><text x="1" y="5">hi</text></svg>')
    expect(r.warnings).toEqual([{ code: 'svg.ignored_elements', params: { elements: ['text'] } }])
    expect(r.entry.payload.paths.length).toBe(1)
  })
  it('refuses a bad file with the code the dialog explains, so nothing bad is stored', () => {
    expect(() => importSvg('<svg><script>alert(1)</script><rect width="1" height="1"/></svg>')).toThrowError(expect.objectContaining({ code: 'emboss.svg_unsafe' }))
    expect(() => importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 5 H10" fill="none" stroke="black" stroke-width="2"/></svg>')).toThrowError(expect.objectContaining({ code: 'emboss.svg_empty_mode', params: { mode: 'fill' } }))
    expect(() => importSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrowError(expect.objectContaining({ code: 'emboss.empty_shape' }))
    expect(() => importSvg('x'.repeat(2_000_001))).toThrowError(expect.objectContaining({ code: 'emboss.svg_too_large' }))
  })
  it('keeps Line mode with the entry', () => {
    const r = importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 5 H10" fill="none" stroke="black" stroke-width="2"/></svg>', { mode: 'line' })
    expect(r.entry.source.mode).toBe('line'); expect(r.stats.paths).toBeGreaterThan(0)
  })
  it('refreshSvgDrawings rebuilds a drawing from its SVG when another importer version made it, and leaves the rest alone', () => {
    const ok = importSvg(SQUARE).entry
    const stale = { ...ok, payload: { kind: 'drawing' as const, paths: [{ closed: true, points: [[0, 0], [1, 0], [1, 1]] as Array<[number, number]> }] }, source: { ...ok.source, importer: SVG_IMPORTER_VERSION - 1 } }
    const store = { fresh: ok, old: stale, model: { payload: ok.payload } }
    const r = refreshSvgDrawings(store)
    expect(r.rebuilt).toEqual(['old']); expect(r.failed).toEqual([])
    expect(r.store['old']!.payload).toEqual(ok.payload)           // the SVG won
    expect(r.store['old']!.source!.importer).toBe(SVG_IMPORTER_VERSION)
    expect(r.store['fresh']).toBe(store.fresh)
    expect(refreshSvgDrawings({ fresh: ok }).store).toBeTruthy()
    const same = { fresh: ok }
    expect(refreshSvgDrawings(same).store).toBe(same)              // nothing to do: the same object
  })
  it('reports an entry whose SVG can no longer be imported and keeps its drawing', () => {
    const ok = importSvg(SQUARE).entry
    const broken = { ...ok, source: { ...ok.source, text: '<svg></svg>', importer: SVG_IMPORTER_VERSION - 1 } }
    const r = refreshSvgDrawings({ b: broken })
    expect(r.failed.map(f => f.name)).toEqual(['b']); expect(r.store['b']!.payload).toBe(ok.payload)
  })
})

describe('SVG fill and line', () => {
  const both = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="40" height="40" fill="black" stroke="red" stroke-width="10"/></svg>'
  it('fill (the default) uses the filled areas and ignores the stroke', () => {
    const s = svgToShape(both, { size: 40, tolerance: 0.01 })
    expect(fillArea(s.rings)).toBeCloseTo(40 * 40, 3)
  })
  it('line uses only the stroke, at the stroke width, and ignores the fill', () => {
    const s = svgToShape(both, { size: 50, tolerance: 0.01, mode: 'line' })   // 50 high with the stroke: 10 stroke around a 40 square
    expect(s.bbox[3] - s.bbox[1]).toBeCloseTo(50, 5)
    // the outline of the square widened by 10 minus the inner hole (30 x 30 less rounded corners): a ring, so it has a hole
    expect(s.rings.length).toBe(2)
    expect(fillArea(s.rings)).toBeLessThan(50 * 50 - 30 * 30 + 1)
  })
  it('a mode with nothing to use is a clear error', () => {
    const strokeOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 5 H10" fill="none" stroke="black" stroke-width="2"/></svg>'
    expect(() => svgToShape(strokeOnly, { size: 10, tolerance: 0.01 })).toThrowError(expect.objectContaining({ code: 'emboss.svg_empty_mode', params: { mode: 'fill' } }))
    const fillOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    expect(() => svgToShape(fillOnly, { size: 10, tolerance: 0.01, mode: 'line' })).toThrowError(expect.objectContaining({ code: 'emboss.svg_empty_mode', params: { mode: 'line' } }))
  })
  it('the operation defaults to fill', async () => {
    const res = await embossSvg({}, both)
    expect(res.status, JSON.stringify(res.error)).toBe('ok')
    expect(area(res.mesh!, 'text')).toBeCloseTo(10 * 10, 3)  // the 10 x 10 filled square on top (walls are in their own part)
  })
})

describe('two segments: surface and side walls', () => {
  it('raised: the top is `text`, the side walls are `text_walls`', async () => {
    const res = await embossSvg({ height: 0.8 })
    const m = res.mesh!
    expect(m.segments!.table.map(s => s.name)).toEqual(['body', 'text', 'text_walls'])
    expect(area(m, 'text')).toBeCloseTo(100, 3)
    expect(area(m, 'text_walls')).toBeCloseTo(4 * 10 * 0.8, 3)
    expect(measureMesh(m).watertight).toBe(true)
  })
  it('engraved: the floor is `text`, the walls are `text_walls`', async () => {
    const res = await embossSvg({ mode: 'engraved', height: 0.6 })
    const m = res.mesh!
    expect(area(m, 'text')).toBeCloseTo(100, 3)
    expect(area(m, 'text_walls')).toBeCloseTo(4 * 10 * 0.6, 3)
  })
  it('an empty walls_segment keeps one part for both, as before; another name is used as given', async () => {
    const one = (await embossSvg({ walls_segment: '' })).mesh!
    expect(one.segments!.table.map(s => s.name)).toEqual(['body', 'text'])
    expect(area(one, 'text')).toBeCloseTo(100 + 32, 3)
    const named = (await embossSvg({ walls_segment: 'sides' })).mesh!
    expect(named.segments!.table.map(s => s.name)).toEqual(['body', 'text', 'sides'])
  })
})

describe('old projects: the text/SVG switch became two operations', () => {
  const old = (params: Record<string, unknown>) => makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: '0.1.0' }, op: 'emboss', params })
  it('a stored SVG step (op emboss, source svg) becomes emboss_svg with no drawing chosen yet (the SVG file is not carried over: no saved project had one)', async () => {
    const step = old({ source: 'svg', svg: 'x', text: 'Text', font: null, weight: 400, size: 10, align: 'center', spacing: 0, line_spacing: 1.2, placement, height: 0.8, mode: 'raised' })
    const moved = await migrateStep(step, registry())
    expect(moved.step.op).toBe('emboss_svg')
    expect(moved.step.params['source']).toBeUndefined()
    expect(moved.step.params['text']).toBeUndefined()
    expect(moved.step.params['svg']).toBeUndefined()
    expect(moved.step.params['shape']).toBeNull()
    expect(registry().validateStep(moved.step).ok).toBe(true)
    const r = await runWorkflow({ ...emptyStepList(), steps: [step] }, { registry: registry(), source: plate })
    expect(r.results[0]!.error?.code).toBe('emboss.no_shape')
  })
  it('an emboss_svg step of 0.3.0 loses its svg and svg_mode and gets an empty shape', async () => {
    const step = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: '0.3.0' }, op: 'emboss_svg', params: { placement, svg: 'x', svg_mode: 'line', size: 10 } })
    const moved = await migrateStep(step, registry())
    expect(moved.step.params['svg']).toBeUndefined(); expect(moved.step.params['svg_mode']).toBeUndefined(); expect(moved.step.params['shape']).toBeNull()
    expect(moved.step.params['size']).toBe(10)
    expect(registry().validateStep(moved.step).ok).toBe(true)
  })
  it('a stored text step keeps its op, drops the old source and svg params, and gets the new defaults', async () => {
    const moved = await migrateStep(old({ source: 'text', svg: null, text: 'Anna', font: 'f', size: 8, placement }), registry())
    expect(moved.step.op).toBe('emboss')
    expect(moved.step.params['source']).toBeUndefined()
    expect(moved.step.params['svg']).toBeUndefined()
    expect(registry().validateStep(moved.step).ok).toBe(true)
  })
  it('the text operation still accepts a `source` value and ignores it', () => {
    const step = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { source: 'text', text: 'A', font: 'f', size: 8, placement } })
    expect(registry().validateStep(step).ok).toBe(true)
  })
})
