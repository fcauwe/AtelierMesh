// Name plate, as plain JavaScript: ONE file, no imports, no build. It shows how a plugin gets letter outlines: it asks the HOST,
//   const o = await ctx.fonts.outline(fontId, text, { size })
// and gets back polygons in millimetres (y up): o.contours (outer contours counter-clockwise, holes clockwise), o.bbox [x0, y0, x1, y1], o.fillRule 'nonzero'.
// The manifest says `"uses": ["fonts"]`, so a host without this service refuses the step before it starts.

const problem = (code, params = {}) => ({ code, params })

/** A closed box (8 vertices, 12 triangles, outward faces) from x0..x1, y0..y1, z0..z1. */
function box(x0, y0, z0, x1, y1, z1) {
  const positions = new Float64Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

/** SVG path data for the contours (y flipped: SVG's y points down). */
const toPath = contours => contours.map(c => c.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${(-y).toFixed(3)}`).join('') + 'Z').join('')

export default {
  async run(op, ctx) {
    if (op !== 'nameplate') throw problem('step.unknown_op', { op })
    const p = ctx.params
    ctx.progress('letters', 0)
    // can throw emboss.missing_glyphs (characters: [...]), emboss.empty_text, emboss.text_too_long, emboss.font_unreadable, fonts.unavailable
    const o = await ctx.fonts.outline(p.font, p.text, { size: p.size })
    if (ctx.signal.aborted) throw problem('run.cancelled')
    const [x0, y0, x1, y1] = o.bbox
    const m = p.margin
    ctx.progress('plate', 0.5)
    const mesh = box(x0 - m, y0 - m, 0, x1 + m, y1 + m, p.thickness)
    return { mesh, report: { width: x1 - x0 + 2 * m, height: y1 - y0 + 2 * m, letters: o.contours.length, svg_path: toPath(o.contours) } }
  },
}
