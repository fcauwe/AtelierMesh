import { describe, expect, it } from 'vitest'
import { fillArea } from '../src/emboss/shape'
import { svgToShape } from '../src/emboss/svg'

const svg = (inner: string, attrs = 'viewBox="0 0 100 100"'): string => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`
const shape = (s: string, size = 20, extra: Partial<Parameters<typeof svgToShape>[1]> = {}) => svgToShape(s, { size, tolerance: 0.01, ...extra })

describe('svg source', () => {
  it('scales the artwork to the requested height and centres it on the anchor', () => {
    const s = shape(svg('<rect x="10" y="20" width="60" height="30"/>'), 15)
    expect(s.bbox[3] - s.bbox[1]).toBeCloseTo(15, 6)
    expect(s.bbox[2] - s.bbox[0]).toBeCloseTo(30, 6)             // 2:1 stays 2:1
    expect((s.bbox[0] + s.bbox[2]) / 2).toBeCloseTo(0, 9)
    expect((s.bbox[1] + s.bbox[3]) / 2).toBeCloseTo(0, 9)
    expect(fillArea(s.rings)).toBeCloseTo(30 * 15, 6)
  })

  it('is not upside down: SVG y points down, the map y points up', () => {
    // a triangle with its point at the top of the picture (small y)
    const s = shape(svg('<path d="M50 0 L100 100 L0 100 Z"/>'), 10, { anchor: { h: 'center', v: 'baseline' } })
    // baseline anchor = the bottom of the artwork at y = 0; the point must be at +10
    const top = s.rings.flat().reduce((m, p) => (p[1] > m[1] ? p : m))
    expect(top[1]).toBeCloseTo(10, 6)
    expect(top[0]).toBeCloseTo(0, 6)
  })

  it('curves: a circle has the area of a circle', () => {
    const s = shape(svg('<circle cx="50" cy="50" r="40"/>'), 20)
    expect(fillArea(s.rings)).toBeCloseTo(Math.PI * 100, 0)
  })

  it('fill rules: even-odd makes a hole, non-zero (same winding) does not', () => {
    const ring = 'M0 0H100V100H0Z M25 25H75V75H25Z'
    const eo = shape(svg(`<path fill-rule="evenodd" d="${ring}"/>`), 100)
    const nz = shape(svg(`<path d="${ring}"/>`), 100)
    expect(fillArea(eo.rings)).toBeCloseTo(100 * 100 - 50 * 50, 4)
    expect(fillArea(nz.rings)).toBeCloseTo(100 * 100, 4)
  })

  it('transforms on the element and on its groups are applied, inner first', () => {
    const plain = shape(svg('<rect x="0" y="0" width="10" height="10"/>'), 10)
    const moved = shape(svg('<g transform="translate(50 0)"><rect transform="scale(2)" x="0" y="0" width="5" height="5"/></g>'), 10)
    expect(fillArea(moved.rings)).toBeCloseTo(fillArea(plain.rings), 6)
    const two = shape(svg('<g transform="translate(60 0)"><rect transform="scale(2)" width="5" height="5"/></g><rect width="10" height="10"/>'), 10)
    expect(two.rings.length).toBe(2)
    expect(two.bbox[2] - two.bbox[0]).toBeCloseTo(70, 5)  // the artwork is 70 wide and 10 tall at size 10
  })

  it('overlapping shapes merge into one; strokes become outlines of the stroke width', () => {
    const merged = shape(svg('<rect width="60" height="60"/><rect x="30" y="30" width="60" height="60"/>'), 90)
    expect(fillArea(merged.rings)).toBeCloseTo(60 * 60 * 2 - 30 * 30, 4)
    expect(merged.rings.length).toBe(1)
    const line = shape(svg('<path d="M10 50 H90" fill="none" stroke="black" stroke-width="10" stroke-linecap="butt"/>'), 10, { mode: 'line' })
    // a 80 long line, 10 wide, with round caps: 80 x 10 plus a full circle of radius 5; scaled so the height (10) stays 10 mm
    expect(line.bbox[3] - line.bbox[1]).toBeCloseTo(10, 6)
    expect(fillArea(line.rings)).toBeCloseTo(80 * 10 + Math.PI * 25, 0)
  })

  it('ignores what does not draw: display none, defs, clip paths, and reports use and images', () => {
    const s = shape(svg('<defs><rect id="x" width="500" height="500"/></defs><rect width="10" height="10"/><rect display="none" width="900" height="900"/><g style="display:none"><circle r="400"/></g><use href="#x"/><image href="a.png"/>'), 10)
    expect(fillArea(s.rings)).toBeCloseTo(100, 6)
    expect(s.ignored.sort()).toEqual(['image', 'use'])
  })

  it('max_width scales down and reports the factor', () => {
    const s = shape(svg('<rect width="100" height="10"/>'), 10, { maxWidth: 50 })
    expect(s.bbox[2] - s.bbox[0]).toBeCloseTo(50, 6)
    expect(s.fitScale).toBeCloseTo(0.5, 9)
  })

  it('refuses scripts, entities, empty drawings and huge files', () => {
    for (const bad of ['<script>x</script>', '<!DOCTYPE svg [<!ENTITY a "b">]>', '<foreignObject/>']) {
      expect(() => shape(svg(bad + '<rect width="1" height="1"/>'))).toThrowError(expect.objectContaining({ code: 'emboss.svg_unsafe' }))
    }
    expect(() => shape(svg('<rect width="0" height="5"/>'))).toThrowError(expect.objectContaining({ code: 'emboss.empty_shape' }))
    expect(() => shape(svg('<g/>'))).toThrowError(expect.objectContaining({ code: 'emboss.empty_shape' }))
    expect(() => shape('x'.repeat(2_100_000))).toThrowError(expect.objectContaining({ code: 'emboss.svg_too_large' }))
  })
})
