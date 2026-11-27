import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fontOutlines, createFontService, outlinesToSvgPath, getFont } from '../src'
import { layoutText } from '../src/emboss/text'
import { fillArea as fillAreaDirect } from '../src/emboss/shape'

const ROBOTO = new Uint8Array(fs.readFileSync(fileURLToPath(new URL('../../../apps/standalone/public/fonts/roboto-regular.woff2', import.meta.url))))
const area = (r: Array<[number, number]>): number => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }

describe('fontOutlines', () => {
  it('outer contours run counter-clockwise, holes clockwise, in millimetres from the left edge and the baseline', async () => {
    const font = await getFont(ROBOTO)
    const o = fontOutlines(font, 'Oo8', { size: 10 })
    expect(o.fillRule).toBe('nonzero')
    const outer = o.contours.filter(c => area(c) > 0), holes = o.contours.filter(c => area(c) < 0)
    expect(outer.length).toBe(3)          // O, o, 8 (an island inside the 8 would add more, Roboto's has none)
    expect(holes.length).toBe(4)          // O, o and the two of the 8
    expect(o.bbox[0]).toBeCloseTo(0, 6)   // the letters start at x = 0
    expect(o.bbox[1]).toBeLessThan(0.3)   // round letters dip a little under the baseline
    expect(o.bbox[3]).toBeGreaterThan(9.5); expect(o.bbox[3]).toBeLessThan(11)   // capital height 10 mm (round letters overshoot a bit)
    // the area: outer minus holes is the same with either rule
    const net = outer.reduce((s, c) => s + area(c), 0) + holes.reduce((s, c) => s + area(c), 0)
    expect(net).toBeCloseTo(fillAreaDirect(o.contours), 3)
  })
  it('gives the same letters the text step cuts (same code), only the winding is fixed', async () => {
    const font = await getFont(ROBOTO)
    const a = fontOutlines(font, 'Anna', { size: 8, tolerance: 0.01 })
    const b = layoutText(font as never, { text: 'Anna', size: 8, tolerance: 0.01, anchor: { h: 'left', v: 'baseline' } })
    expect(a.contours.length).toBe(b.rings.length)
    expect(a.bbox).toEqual(b.bbox)
    expect(Math.abs(fillAreaDirect(a.contours) - fillAreaDirect(b.rings))).toBeLessThan(1e-9)
  })
  it('options: weight on a static font is ignored, alignment, spacing, anchor, maxWidth', async () => {
    const font = await getFont(ROBOTO)
    const plain = fontOutlines(font, 'AB', { size: 10 })
    const spaced = fontOutlines(font, 'AB', { size: 10, letterSpacing: 2 })
    expect(spaced.bbox[2] - spaced.bbox[0]).toBeCloseTo(plain.bbox[2] - plain.bbox[0] + 2, 3)
    const centred = fontOutlines(font, 'AB', { size: 10, anchor: { h: 'center', v: 'middle' } })
    expect((centred.bbox[0] + centred.bbox[2]) / 2).toBeCloseTo(0, 6)
    const fitted = fontOutlines(font, 'AB', { size: 10, maxWidth: 5 })
    expect(fitted.bbox[2] - fitted.bbox[0]).toBeCloseTo(5, 3); expect(fitted.fitScale).toBeLessThan(1)
    expect(fontOutlines(font, 'A\nB', { size: 10 }).lines).toBe(2)
  })
  it('says so by name when the font lacks a character, and refuses empty and too long text', async () => {
    const font = await getFont(ROBOTO)
    expect(() => fontOutlines(font, '中', { size: 10 })).toThrowError(expect.objectContaining({ code: 'emboss.missing_glyphs' }))
    expect(() => fontOutlines(font, '  ', { size: 10 })).toThrowError(expect.objectContaining({ code: 'emboss.empty_text' }))
    expect(() => fontOutlines(font, 'a'.repeat(201), { size: 10 })).toThrowError(expect.objectContaining({ code: 'emboss.text_too_long' }))
  })
  it('turns outlines into SVG path data, y flipped by default', async () => {
    expect(outlinesToSvgPath([[[0, 0], [2, 0], [2, 1]]])).toBe('M0 0L2 0L2 -1Z')
    expect(outlinesToSvgPath([[[0, 0], [2, 0.12345], [2, 1]]], { flipY: false, digits: 2 })).toBe('M0 0L2 0.12L2 1Z')
  })
})

describe('createFontService', () => {
  it('reads the font through the host resolver, remembers results and reports a missing font', async () => {
    let reads = 0
    const svc = createFontService(async id => { reads++; if (id !== 'font:Roboto') throw new Error('no such asset'); return ROBOTO })
    const a = await svc('font:Roboto', 'Hi', { size: 10 }), b = await svc('font:Roboto', 'Hi', { size: 10 })
    expect(b).toBe(a)                                       // same answer from memory
    expect(reads).toBe(2)                                   // the bytes are asked for each time (the host caches them), the outlines only once
    await expect(svc('font:Nope', 'Hi', { size: 10 })).rejects.toThrow('no such asset')
    await expect(svc('', 'Hi', { size: 10 })).rejects.toMatchObject({ code: 'emboss.no_font' })
  })
})
