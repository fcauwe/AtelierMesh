import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { IDENTITY4, Registry, addStep, emptyStepList, followEarlierSteps, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import fs from 'node:fs'
import path from 'node:path'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '../src'
import { fillArea, flattenPath, unionNonZero } from '../src/emboss/shape'
import { layoutText, loadFont } from '../src/emboss/text'
import { gridBox } from './parts'

// The Atelier's fonts, used read-only. The tests are skipped when the folder is not there.
const FONTS = fileURLToPath(new URL('../../../assets/atelier/frontend/public/fonts', import.meta.url))
const have = fs.existsSync(FONTS)
const d = have ? describe : describe.skip

const registry = (): Registry => new Registry().register(corePlugin())
const plate = gridBox(70, 30, 4, 140, 60, 8)
const placement = { anchor: { point: [0, 0, 4], normal: [0, 0, 1] } }
const fontBytes = (f: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FONTS, f)))

async function emboss(params: Record<string, unknown>, quality: 'preview' | 'export' = 'export') {
  const l = addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { placement, font: 'roboto', ...params } }))
  const r = await runWorkflow(l, { registry: registry(), source: plate, quality, assets: async id => fontBytes(id === 'pacifico' ? 'Pacifico-Regular.woff2' : 'roboto-v51-latin-regular.woff2') })
  return r.results[0]!
}

const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M50 5 L61 38 L96 38 L68 58 L79 92 L50 71 L21 92 L32 58 L4 38 L39 38 Z M50 35 L56 48 L44 48 Z"/></svg>'

describe('emboss with an SVG source', () => {
  it('embosses an SVG with a hole as one closed mesh; the volume change is its area times the height', async () => {
    const l = addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss_svg', params: { placement, shape: 'star', size: 14, height: 0.8 } }))
    const { svgToDrawing, drawingToShape } = await import('../src/emboss/svg')
    const star = svgToDrawing(STAR)
    const r = await runWorkflow(l, { registry: registry(), source: plate, store: { star: { payload: star } } })
    const res = r.results[0]!
    expect(res.status, JSON.stringify(res.error)).toBe('ok')
    const shape = drawingToShape(star, { size: 14 })
    expect(measureMesh(res.mesh!).watertight).toBe(true)
    expect(measureMesh(res.mesh!).volume - measureMesh(plate).volume).toBeCloseTo(fillArea(shape.rings) * 0.8, 3)
    // the small triangle is a hole: the area is less than the full star
    expect(fillArea(shape.rings)).toBeLessThan(fillArea(shape.rings.slice(0, 1)))
  })
  it('asks for a drawing when none is chosen, and for one that exists', async () => {
    const l = addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss_svg', params: { placement } }))
    const r = await runWorkflow(l, { registry: registry(), source: plate })
    expect(r.results[0]!.error?.code).toBe('emboss.no_shape')
    const named = await runWorkflow(addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss_svg', params: { placement, shape: 'ghost' } })), { registry: registry(), source: plate })
    expect(named.results[0]!.error).toMatchObject({ code: 'input.missing_payload', params: { name: 'ghost' } })
  })
})

d('emboss with real fonts', () => {
  const base = measureMesh(plate).volume

  it('raises "Anna" as one closed mesh; the volume change is the glyph area times the height', async () => {
    const res = await emboss({ text: 'Anna', size: 10, height: 0.8 })
    expect(res.status).toBe('ok')
    const m = measureMesh(res.mesh!)
    expect(m.watertight).toBe(true)
    const font = await loadFont(fontBytes('roboto-v51-latin-regular.woff2'))
    const shape = layoutText(font, { text: 'Anna', size: 10, tolerance: 0.01 })
    expect(m.volume - base).toBeCloseTo(fillArea(shape.rings) * 0.8, 3)
    expect(res.report!['volume_estimate'] as number).toBeCloseTo(fillArea(shape.rings) * 0.8, 3)
    expect(res.mesh!.segments!.table.map(s => s.name)).toEqual(['body', 'text', 'text_walls'])
  })

  it('engraved removes about the same volume', async () => {
    const raised = await emboss({ text: 'Anna', size: 10, height: 0.8 })
    const eng = await emboss({ text: 'Anna', size: 10, height: 0.8, mode: 'engraved' })
    expect(eng.status).toBe('ok')
    expect(base - measureMesh(eng.mesh!).volume).toBeCloseTo(measureMesh(raised.mesh!).volume - base, 3)
  })

  it('a script font with overlapping letters gives one merged shape and counts the overlap once', async () => {
    const res = await emboss({ text: 'Anna Éloïse', font: 'pacifico', size: 8, height: 0.6 })
    expect(res.status, JSON.stringify(res.error)).toBe('ok')
    const font = await loadFont(fontBytes('Pacifico-Regular.woff2'))
    const merged = fillArea(layoutText(font, { text: 'Anna Éloïse', size: 8, tolerance: 0.01 }).rings)
    // glyph by glyph (each one merged alone, then added up) the area is larger, because overlaps between letters are counted twice
    const run = font.layout('Anna Éloïse')
    const scale = 8 / font.capHeight
    let x = 0, separate = 0
    run.glyphs.forEach((g, i) => {
      separate += fillArea(unionNonZero(flattenPath(g.path.commands, scale, 0.01, x + run.positions[i]!.xOffset * scale, 0)))
      x += run.positions[i]!.xAdvance * scale
    })
    expect(separate).toBeGreaterThan(merged + 1)
    expect(measureMesh(res.mesh!).volume - base).toBeCloseTo(merged * 0.6, 2)
    expect(measureMesh(res.mesh!).watertight).toBe(true)
  })

  it('the same asset id with different bytes gives a different font (the parsed font is cached by content, not by id)', async () => {
    const run = async (file: string) => {
      const l = addStep(emptyStepList(), makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { placement, font: 'same-id', text: 'Anna', size: 10 } }))
      return (await runWorkflow(l, { registry: registry(), source: plate, assets: async () => fontBytes(file) })).results[0]!.report!['volume_estimate'] as number
    }
    const roboto = await run('roboto-v51-latin-regular.woff2'), pacifico = await run('Pacifico-Regular.woff2')
    expect(Math.abs(roboto - pacifico)).toBeGreaterThan(0.5)
  })

  it('two texts on one part: both are added, the mesh stays one closed surface, and the second sees the first', async () => {
    const step = (id: string, text: string, x: number, mode: string) => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { font: 'roboto', text, size: 5, mode, height: 0.6, segment: id === 'a' ? 'first' : 'second', placement: { anchor: { point: [x, 0, 4], normal: [0, 0, 1] } } } })
    const one = await runWorkflow(addStep(emptyStepList(), step('a', 'Anna', -15, 'raised')), { registry: registry(), source: plate, assets: async () => fontBytes('roboto-v51-latin-regular.woff2') })
    const two = await runWorkflow([step('a', 'Anna', -15, 'raised'), step('b', 'Bea', 15, 'engraved')].reduce((l, s) => addStep(l, s), emptyStepList()), { registry: registry(), source: plate, assets: async () => fontBytes('roboto-v51-latin-regular.woff2') })
    expect(two.ok, JSON.stringify(two.results.map(r => r.error))).toBe(true)
    const m = measureMesh(two.mesh!)
    expect(m.watertight).toBe(true)
    expect(two.mesh!.segments!.table.map(s => s.name)).toEqual(['body', 'first', 'text_walls', 'second'])
    // raised adds volume, engraved takes some away
    expect(measureMesh(one.mesh!).volume).toBeGreaterThan(measureMesh(plate).volume)
    expect(m.volume).toBeLessThan(measureMesh(one.mesh!).volume)
    expect(two.results[1]!.report!['volume_estimate'] as number).toBeLessThan(0)
  })

  it('accents work', async () => {
    const res = await emboss({ text: 'Éloïse', size: 8 })
    expect(res.status).toBe('ok')
    expect(measureMesh(res.mesh!).watertight).toBe(true)
  })

  it('clear messages: empty string, too long, missing glyph, no placement, no font', async () => {
    expect((await emboss({ text: '   ' })).error?.code).toBe('emboss.empty_text')
    expect((await emboss({ text: 'x'.repeat(250) })).error?.code).toBe('param.too_long')
    const missing = await emboss({ text: 'A漢' })
    expect(missing.error).toMatchObject({ code: 'emboss.missing_glyphs', params: { characters: ['漢'] } })
    expect((await emboss({ text: 'Hi', placement: null })).error?.code).toBe('emboss.no_placement')
    expect((await emboss({ text: 'Hi', font: null })).error?.code).toBe('emboss.no_font')
  })

  it('text that runs off the part fails clearly; text that is too small only warns', async () => {
    const off = await emboss({ text: 'WWWWWWWWWWWWWWWWWWWW', size: 8 })
    expect(off.error?.code).toBe('emboss.touches_patch_edge')
    // the error names a size that works, and that size really works
    const fit = (off.error?.params as { fit_size?: number } | undefined)?.fit_size
    expect(fit).toBeGreaterThan(0); expect(fit).toBeLessThan(8)
    expect((await emboss({ text: 'WWWWWWWWWWWWWWWWWWWW', size: fit as number })).status).toBe('ok')
    const small = await emboss({ text: 'Hi', size: 1.2, height: 0.2 })
    expect(small.status).toBe('ok')
    expect(small.warnings?.some(w => w.code === 'emboss.text_small')).toBe(true)
  })

  it('warns when the strokes are thinner than the printer can lay down, and reports the mean stroke width', async () => {
    const bold = await emboss({ text: 'Anna', size: 8 })
    expect(bold.warnings?.some(w => w.code === 'emboss.thin_strokes')).toBe(false)
    expect(bold.report!['mean_stroke'] as number).toBeGreaterThan(0.6)
    const fine = await emboss({ text: 'Anna', font: 'pacifico', size: 2.5, height: 0.3 })
    expect(fine.status).toBe('ok')
    expect(fine.warnings?.some(w => w.code === 'emboss.thin_strokes')).toBe(true)
    // the limit is a parameter
    expect((await emboss({ text: 'Anna', font: 'pacifico', size: 2.5, height: 0.3, min_stroke: 0 })).warnings?.some(w => w.code === 'emboss.thin_strokes')).toBe(false)
  })

  it('max_width scales the text down to fit, and says so', async () => {
    const res = await emboss({ text: 'Hello World', size: 8, max_width: 30 })
    expect(res.status).toBe('ok')
    expect(res.report!['text_width'] as number).toBeLessThanOrEqual(30.0001)
    expect(res.warnings?.some(w => w.code === 'emboss.text_scaled_to_fit')).toBe(true)
  })

  it('several lines and right alignment', async () => {
    const res = await emboss({ text: 'Anna\nEloise Marie', size: 6, align: 'right' })
    expect(res.status).toBe('ok')
    expect(res.report!['lines']).toBe(2)
  })

  it('is a pure function of its inputs: the same step gives the same bytes', async () => {
    const a = await emboss({ text: 'Anna', size: 10 }), b = await emboss({ text: 'Anna', size: 10 })
    expect(Array.from(a.mesh!.positions)).toEqual(Array.from(b.mesh!.positions))
    expect(Array.from(a.mesh!.indices)).toEqual(Array.from(b.mesh!.indices))
  })

  it('the preview uses a coarser curve tolerance than the export', async () => {
    const p = await emboss({ text: 'Anna', size: 10 }, 'preview'), e = await emboss({ text: 'Anna', size: 10 }, 'export')
    expect((p.mesh as Mesh).indices.length).toBeLessThan((e.mesh as Mesh).indices.length)
  })
})

d('placements follow earlier steps (the placement survives a resize before it)', () => {
  const step = (id: string, op: string, params: Record<string, unknown>) => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op, params })
  const centre = (m: Mesh, minZ = 5.5): { x: number; y: number; z: number } => {
    const sel = m.segments!.labels, T = m.indices, P = m.positions
    let a = 0, cx = 0, cy = 0, cz = 0
    for (let t = 0; t < sel.length; t++) {
      if (sel[t] !== 1) continue
      const v = [0, 1, 2].map(k => T[3 * t + k]!)
      if (v.some(i => P[3 * i + 2]! < minZ)) continue    // top faces only
      const [p, q, r] = v.map(i => [P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!]) as [number[], number[], number[]]
      const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], w = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!]
      const area = 0.5 * Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!)
      a += area; cx += area * (p[0]! + q[0]! + r[0]!) / 3; cy += area * (p[1]! + q[1]! + r[1]!) / 3; cz += area * (p[2]! + q[2]! + r[2]!) / 3
    }
    return { x: cx / a, y: cy / a, z: cz / a }
  }
  const run = async (steps: ReturnType<typeof step>[]) => runWorkflow(steps.reduce((l, s) => addStep(l, s), emptyStepList()), {
    registry: registry(), source: plate, assets: async () => fontBytes('roboto-v51-latin-regular.woff2'), prepareStep: followEarlierSteps(),
  })
  const emb = (anchor: number[], frame?: number[]) => step('e', 'emboss', { font: 'roboto', text: 'Hi', size: 6, placement: { anchor: { point: anchor, normal: [0, 0, 1] }, ...(frame ? { frame } : {}) } })

  it('a resize inserted before the text moves the anchor with the surface', async () => {
    const before = await run([emb([10, 5, 4], IDENTITY4)])
    const c0 = centre(before.mesh!, 4.5)
    expect(c0.x).toBeCloseTo(10, 0); expect(c0.y).toBeCloseTo(5, 0)
    // the same text, but a 200 percent resize (about the bbox centre, which is (0, 0, 2)) now comes first
    const after = await run([step('r', 'resize', { percent: 200 }), emb([10, 5, 4], IDENTITY4)])
    expect(after.ok, JSON.stringify(after.results.map(r => r.error))).toBe(true)
    const c1 = (() => { const m = after.mesh!; return centre(m) })()
    expect(c1.x).toBeCloseTo(20, 0); expect(c1.y).toBeCloseTo(10, 0)         // twice as far from the centre
    expect(measureMesh(after.mesh!).watertight).toBe(true)
  })

  it('a rotation before the text carries the anchor round with the part', async () => {
    const r = await run([step('r', 'rotate', { angles: [0, 0, 90] }), emb([10, 5, 4], IDENTITY4)])
    expect(r.ok, JSON.stringify(r.results.map(x => x.error))).toBe(true)
    const m = r.mesh!
    // the plate is turned about its centre (0,0): the point (10,5) goes to (-5,10), and the plate top stays at z = 4
    let a = 0, cx = 0, cy = 0
    for (let t = 0; t < m.segments!.labels.length; t++) {
      if (m.segments!.labels[t] !== 1) continue
      const v = [0, 1, 2].map(k => m.indices[3 * t + k]!)
      if (v.some(i => m.positions[3 * i + 2]! < 4.5)) continue
      for (const i of v) { cx += m.positions[3 * i]!; cy += m.positions[3 * i + 1]!; a++ }
    }
    expect(cx / a).toBeCloseTo(-5, 0); expect(cy / a).toBeCloseTo(10, 0)
  })

  it('the text turns with the part: a 90 degree turn makes a long word read along y', async () => {
    const word = (steps: ReturnType<typeof step>[]) => run(steps)
    const long = (anchor: number[]) => step('e', 'emboss', { font: 'roboto', text: 'Hello', size: 5, placement: { anchor: { point: anchor, normal: [0, 0, 1] }, frame: IDENTITY4 } })
    const extent = (m: Mesh): { dx: number; dy: number } => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let t = 0; t < m.segments!.labels.length; t++) {
        if (m.segments!.labels[t] !== 1) continue
        for (let k = 0; k < 3; k++) { const i = m.indices[3 * t + k]!; if (m.positions[3 * i + 2]! < 4.5) continue; x0 = Math.min(x0, m.positions[3 * i]!); x1 = Math.max(x1, m.positions[3 * i]!); y0 = Math.min(y0, m.positions[3 * i + 1]!); y1 = Math.max(y1, m.positions[3 * i + 1]!) }
      }
      return { dx: x1 - x0, dy: y1 - y0 }
    }
    const still = extent((await word([long([0, 0, 4])])).mesh!)
    expect(still.dx).toBeGreaterThan(still.dy * 2)
    const turned = extent((await word([step('r', 'rotate', { angles: [0, 0, 90] }), long([0, 0, 4])])).mesh!)
    expect(turned.dy).toBeGreaterThan(turned.dx * 2)             // the same word, now reading along y
    expect(turned.dy).toBeCloseTo(still.dx, 1)
  })

  it('without a recorded frame the placement stays where it is (nothing follows)', async () => {
    const r = await run([step('r', 'resize', { percent: 200 }), emb([10, 5, 6])])
    expect(r.ok).toBe(true)
    const c = centre(r.mesh!, 5.5)
    expect(c.x).toBeCloseTo(10, 0); expect(c.y).toBeCloseTo(5, 0)
  })
})
