// SVG as a source of outlines: paths and basic shapes with transforms, fill rules and strokes, scaled to millimetres.
// Only what draws a flat shape is read. Scripts, external references, filters and images are refused or ignored; the size is capped.
import ClipperLib from 'clipper-lib'
import { MeshError, drawingBounds, drawingPointCount, drawingShapeProblem } from '@ateliermesh/core'
import type { Drawing, ProjectStore, StoreSource } from '@ateliermesh/core'
import svgpath from 'svgpath'
import type { Ring } from './cut'
import { bboxOfRings, flattenPath, unionRings } from './shape'
import type { PathCommand } from './shape'

const SCALE = 10000
export const MAX_SVG_BYTES = 2_000_000

interface Style { fill: string; fillRule: 'nonzero' | 'evenodd'; stroke: string; strokeWidth: number }

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (let m = re.exec(s); m; m = re.exec(s)) out[m[1] as string] = (m[2] ?? m[3]) as string
  return out
}
const styleOf = (a: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of (a['style'] ?? '').split(';')) { const i = part.indexOf(':'); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim() }
  return out
}
const num = (v: string | undefined, d = 0): number => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d }

const f = (x: number): string => String(Math.round(x * 1e6) / 1e6)
function shapeToPath(tag: string, a: Record<string, string>): string | null {
  switch (tag) {
    case 'path': return a['d'] ?? null
    case 'rect': {
      const x = num(a['x']), y = num(a['y']), w = num(a['width']), h = num(a['height'])
      if (!(w > 0 && h > 0)) return null
      let rx = num(a['rx'], num(a['ry'])), ry = num(a['ry'], rx)
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2)
      if (rx <= 0 || ry <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`
      return `M${f(x + rx)} ${f(y)}H${f(x + w - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}V${f(y + h - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}H${f(x + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}V${f(y + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z`
    }
    case 'circle': case 'ellipse': {
      const cx = num(a['cx']), cy = num(a['cy'])
      const rx = tag === 'circle' ? num(a['r']) : num(a['rx']), ry = tag === 'circle' ? rx : num(a['ry'])
      if (!(rx > 0 && ry > 0)) return null
      return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`
    }
    case 'polygon': case 'polyline': {
      const v = (a['points'] ?? '').trim().split(/[\s,]+/).map(Number)
      if (v.length < 4 || v.some(x => !Number.isFinite(x))) return null
      let d = `M${f(v[0] as number)} ${f(v[1] as number)}`
      for (let i = 2; i + 1 < v.length; i += 2) d += `L${f(v[i] as number)} ${f(v[i + 1] as number)}`
      return d + 'Z'
    }
    case 'line': return `M${f(num(a['x1']))} ${f(num(a['y1']))}L${f(num(a['x2']))} ${f(num(a['y2']))}`
    default: return null
  }
}

export interface SvgShape {
  rings: Ring[]
  bbox: [number, number, number, number]
  /** Elements that were skipped (`use`, `image`, `text`, gradients as fill are drawn as plain fill). */
  ignored: string[]
  size: number
  fitScale: number
}

export interface SvgOptions {
  /** `fill` (default): the filled areas, strokes ignored. `line`: the strokes only, widened to their stroke width, fills ignored. */
  mode?: 'fill' | 'line'
  /** Height of the artwork's bounding box, mm. Ignored when `unitScale` is given. */
  size: number
  /** Millimetres per SVG user unit: the artwork keeps its own size (`svgMmPerUnit`) instead of being scaled to `size`. */
  unitScale?: number
  maxWidth?: number
  tolerance: number
  anchor?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' }
  offset?: [number, number]
}

export function svgToShape(svg: string, o: SvgOptions): SvgShape {
  if (svg.length > MAX_SVG_BYTES) throw new MeshError('emboss.svg_too_large', { bytes: svg.length, max: MAX_SVG_BYTES })
  if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject/i.test(svg)) throw new MeshError('emboss.svg_unsafe')
  const ignored = new Set<string>()
  type Item = { d: string; transforms: string[]; style: Style }
  const items: Item[] = []
  const stack: Array<{ tag: string; transform: string; style: Partial<Style>; hidden: boolean }> = []
  const re = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g
  const cleaned = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  let defsDepth = 0, count = 0
  const inherit = (): Partial<Style> => stack.reduce<Partial<Style>>((acc, s) => ({ ...acc, ...s.style }), {})
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    const closing = m[1] === '/', tag = (m[2] as string).replace(/^svg:/, ''), selfClose = m[4] === '/'
    const a = attrs(m[3] as string), st = styleOf(a)
    if (closing) { const top = stack.pop(); if (top && ['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker'].includes(top.tag)) defsDepth--; continue }
    const hidden = st['display'] === 'none' || a['display'] === 'none' || st['visibility'] === 'hidden' || a['visibility'] === 'hidden'
    const style: Partial<Style> = {}
    const fill = st['fill'] ?? a['fill'], rule = st['fill-rule'] ?? a['fill-rule'], stroke = st['stroke'] ?? a['stroke'], sw = st['stroke-width'] ?? a['stroke-width']
    if (fill !== undefined) style.fill = fill
    if (rule === 'evenodd' || rule === 'nonzero') style.fillRule = rule
    if (stroke !== undefined) style.stroke = stroke
    if (sw !== undefined) style.strokeWidth = num(sw, 1)
    const container = ['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker'].includes(tag)
    if (container && !selfClose) defsDepth++
    if (!selfClose) stack.push({ tag, transform: a['transform'] ?? '', style, hidden })
    const here = [...stack.slice(0, selfClose ? undefined : -1)]
    const isHidden = defsDepth > 0 || container || hidden || here.some(s => s.hidden)
    if (['use', 'image', 'text', 'tspan', 'foreignObject'].includes(tag)) { ignored.add(tag); continue }
    const d = isHidden ? null : shapeToPath(tag, a)
    if (d) {
      if (++count > 5000) throw new MeshError('emboss.svg_too_complex', { elements: count })
      const eff: Style = { fill: 'black', fillRule: 'nonzero', stroke: 'none', strokeWidth: 1, ...inherit(), ...style }
      const transforms = [a['transform'] ?? '', ...here.reverse().map(s => s.transform)].filter(Boolean)
      items.push({ d, transforms, style: eff })
    }
  }
  if (items.length === 0) throw new MeshError('emboss.empty_shape')

  const lineMode = o.mode === 'line'
  const hasStroke = (st: Style): boolean => st.stroke !== 'none' && st.stroke !== 'transparent' && st.strokeWidth > 0
  const hasFill = (st: Style): boolean => st.fill !== 'none' && st.fill !== 'transparent'
  if (!items.some(it => (lineMode ? hasStroke(it.style) : hasFill(it.style)))) throw new MeshError('emboss.svg_empty_mode', { mode: lineMode ? 'line' : 'fill' })
  // user units to millimetres: estimate the scale from the control points, so curves can be flattened at a tolerance given in mm
  const prepared = items.map(it => ({ it, cmds: commandsOf(it.d, it.transforms) }))
  let cy0 = Infinity, cy1 = -Infinity
  for (const { it, cmds } of prepared) {
    const pad = lineMode && hasStroke(it.style) ? it.style.strokeWidth / 2 : 0
    for (const c of cmds) for (let i = 1; i < c.args.length; i += 2) { cy0 = Math.min(cy0, (c.args[i] as number) - pad); cy1 = Math.max(cy1, (c.args[i] as number) + pad) }
  }
  if (!(cy1 > cy0)) throw new MeshError('emboss.empty_shape')
  const tolUser = (0.5 * o.tolerance * (cy1 - cy0)) / (o.unitScale ? (cy1 - cy0) * o.unitScale : o.size)
  const all: Ring[] = [], strokes: Ring[] = []
  for (const { it, cmds } of prepared) {
    if (!lineMode && hasFill(it.style)) all.push(...unionRings(flattenPath(cmds, 1, tolUser).filter(r => r.length > 2), it.style.fillRule))
    if (lineMode && hasStroke(it.style)) strokes.push(...strokeOutline(cmds, it.style.strokeWidth, tolUser))
  }
  let rings = unionRings([...all, ...strokes], 'nonzero')
  if (rings.length === 0) throw new MeshError('emboss.empty_shape')
  // flip y (SVG is y down), then scale and place
  rings = rings.map(r => r.map(([x, y]) => [x, -y] as [number, number]))
  const bb = bboxOfRings(rings)
  return { ...fitRings(rings, { ...o, size: o.unitScale ? (bb[3] - bb[1]) * o.unitScale : o.size }), ignored: [...ignored] }
}

/** Scale rings (y up, any units) so their bounding box is `o.size` tall (narrower if `maxWidth` asks), then move the anchor point to the origin plus `offset`. */
function fitRings(input: Ring[], o: Pick<SvgOptions, 'size' | 'maxWidth' | 'anchor' | 'offset'>): { rings: Ring[]; bbox: [number, number, number, number]; size: number; fitScale: number } {
  let rings = input
  let [x0, y0, x1, y1] = bboxOfRings(rings)
  const height = y1 - y0
  if (!(height > 0)) throw new MeshError('emboss.empty_shape')
  let k = o.size / height
  let fit = 1
  if (o.maxWidth && o.maxWidth > 0 && (x1 - x0) * k > o.maxWidth) { fit = o.maxWidth / ((x1 - x0) * k); k *= fit }
  rings = rings.map(r => r.map(([x, y]) => [x * k, y * k] as [number, number]))
  ;[x0, y0, x1, y1] = bboxOfRings(rings)
  const a = o.anchor ?? { h: 'center', v: 'middle' }
  const ax = a.h === 'left' ? x0 : a.h === 'right' ? x1 : (x0 + x1) / 2
  const ay = a.v === 'baseline' ? y0 : (y0 + y1) / 2
  const sx = -ax + (o.offset?.[0] ?? 0), sy = -ay + (o.offset?.[1] ?? 0)
  rings = rings.map(r => r.map(([x, y]) => [x + sx, y + sy] as [number, number]))
  return { rings, bbox: bboxOfRings(rings), size: o.size * fit, fitScale: fit }
}

const MM_PER_PX = 25.4 / 96
/** A CSS length as millimetres (`40mm`, `2cm`, `1.5in`, `12pt`, `3pc`, `100px`, `100`), or null for a percentage or text it cannot read. */
function lengthMm(v: string | undefined): number | null {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|mm|cm|in|pt|pc)?\s*$/.exec(v ?? '')
  if (!m) return null
  const n = parseFloat(m[1] as string)
  const k = { px: MM_PER_PX, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 }[(m[2] ?? 'px') as 'px']
  return n > 0 ? n * k : null
}

/**
 * Millimetres per user unit of an SVG, from its root element: `width` (or `height`) with its unit over the `viewBox`, so `width="40mm" viewBox="0 0 100 50"` is 0.4 mm
 * a unit. Without a usable width and viewBox a user unit is a CSS pixel (25.4 / 96 mm), as in a browser.
 */
export function svgMmPerUnit(svg: string): number {
  const root = /<svg\b([^>]*)>/i.exec(svg)
  const a = root ? attrs(root[1] as string) : {}
  const vb = (a['viewBox'] ?? '').trim().split(/[\s,]+/).map(Number)
  const w = lengthMm(a['width']), h = lengthMm(a['height'])
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    if (w !== null && (vb[2] as number) > 0) return w / (vb[2] as number)
    if (h !== null && (vb[3] as number) > 0) return h / (vb[3] as number)
  }
  return MM_PER_PX
}

/**
 * Turn an SVG into a flat drawing for the project store: closed paths in millimetres at the SVG's own size (`svgMmPerUnit`), y up, the left edge at x = 0 and the bottom at y = 0.
 * `fill` (default) keeps the filled areas; `line` keeps the strokes, widened to their stroke width. Curves are flattened here (to 0.01 mm), so a step never reads SVG.
 * "SVG on the surface" scales the drawing to its own Size setting, so the real size only matters to other steps and to what a person sees in the stored-items list.
 * Throws the SVG errors (`emboss.svg_too_large`, `emboss.svg_unsafe`, `emboss.svg_too_complex`, `emboss.svg_empty_mode`, `emboss.empty_shape`).
 */
export function svgToDrawing(svg: string, opts: { mode?: 'fill' | 'line' } = {}): Drawing & { ignored: string[] } {
  const s = svgToShape(svg, { mode: opts.mode ?? 'fill', size: 0, unitScale: svgMmPerUnit(svg), tolerance: 0.01, anchor: { h: 'left', v: 'baseline' } })
  return { kind: 'drawing', paths: s.rings.map(r => ({ points: r.map(([x, y]) => [x, y] as [number, number]), closed: true })), fillRule: 'nonzero', ignored: s.ignored }
}

/**
 * The version of the SVG importer. Raise it whenever `svgToDrawing` would give a different drawing for the same SVG. The SVG is the single source of truth of a stored drawing;
 * the drawing is extracted from it, and `refreshSvgDrawings` rebuilds a stored drawing from its SVG when it was made by another version.
 */
export const SVG_IMPORTER_VERSION = 1

export interface SvgImportWarning { code: string; params: Record<string, unknown> }
export interface SvgImport {
  /** What goes into the store: the drawing, and the SVG it came from (the source of truth). */
  entry: { payload: Drawing; source: StoreSource }
  /** Things the import left out that the person may not expect (`svg.ignored_elements`: `use`, `image`, `text`, ...). The drawing is still good. */
  warnings: SvgImportWarning[]
  stats: { paths: number; points: number; sizeMm: [number, number] }
}

/**
 * Import an SVG for the store and check it, once: the drawing is extracted, its shape is validated and its size measured. Anything wrong throws a `MeshError` with the code the dialog
 * explains (`emboss.svg_too_large`, `emboss.svg_unsafe`, `emboss.svg_too_complex`, `emboss.svg_empty_mode` with `mode`, `emboss.empty_shape`), so a bad file never reaches the store.
 */
export function importSvg(svg: string, opts: { mode?: 'fill' | 'line' } = {}): SvgImport {
  const mode = opts.mode ?? 'fill'
  const { ignored, ...drawing } = svgToDrawing(svg, { mode })
  const bad = drawingShapeProblem(drawing)
  if (bad) throw new MeshError('emboss.empty_shape', { problem: bad })
  const b = drawingBounds(drawing)
  if (!b || !(b[2] > b[0]) || !(b[3] > b[1])) throw new MeshError('emboss.empty_shape')
  return {
    entry: { payload: drawing, source: { kind: 'svg', text: svg, mode, importer: SVG_IMPORTER_VERSION } },
    warnings: ignored.length > 0 ? [{ code: 'svg.ignored_elements', params: { elements: ignored } }] : [],
    stats: { paths: drawing.paths.length, points: drawingPointCount(drawing), sizeMm: [b[2] - b[0], b[3] - b[1]] },
  }
}

/**
 * Bring the drawings of a store up to date with the importer: an entry whose SVG source was imported by another version is extracted again from the SVG, which wins.
 * An entry that cannot be extracted again (a stricter importer) keeps its drawing and is reported in `failed`. Returns the same store object when nothing changed.
 */
export function refreshSvgDrawings(store: ProjectStore): { store: ProjectStore; rebuilt: string[]; failed: Array<{ name: string; error: unknown }> } {
  const rebuilt: string[] = [], failed: Array<{ name: string; error: unknown }> = []
  let out = store
  for (const [name, e] of Object.entries(store)) {
    if (!e.source || e.source.kind !== 'svg' || e.source.importer === SVG_IMPORTER_VERSION) continue
    try {
      const r = importSvg(e.source.text, { mode: e.source.mode })
      if (out === store) out = { ...store }
      out[name] = { ...e, payload: r.entry.payload, source: r.entry.source }
      rebuilt.push(name)
    } catch (error) { failed.push({ name, error }) }
  }
  return { store: out, rebuilt, failed }
}

export interface DrawingShape { rings: Ring[]; bbox: [number, number, number, number]; size: number; fitScale: number; openPathsIgnored: number }

/**
 * The outlines emboss works from, taken from a drawing: its closed paths, filled by the drawing's rule, scaled so the bounding box is `o.size` tall (`fitScale` below 1 when
 * `maxWidth` made it smaller) and placed by `anchor` and `offset`. Open paths cannot be filled and are left out (counted in `openPathsIgnored`).
 */
export function drawingToShape(d: Drawing, o: Pick<SvgOptions, 'size' | 'maxWidth' | 'anchor' | 'offset'>): DrawingShape {
  const closed = d.paths.filter(p => p.closed && p.points.length >= 3)
  const rings = unionRings(closed.map(p => p.points.map(([x, y]) => [x, y] as [number, number])), d.fillRule ?? 'nonzero')
  if (rings.length === 0) throw new MeshError('emboss.empty_shape')
  return { ...fitRings(rings, o), openPathsIgnored: d.paths.length - closed.length }
}

function commandsOf(d: string, transforms: string[]): PathCommand[] {
  // innermost first: the element's own transform, then its parents'
  let sp = svgpath(d).abs().unshort().unarc()
  for (const t of transforms) sp = sp.transform(t)
  const cmds: PathCommand[] = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  sp.iterate(seg => {
    const c = seg[0] as string
    const n = (i: number): number => seg[i] as number
    if (c === 'M') { cmds.push({ command: 'moveTo', args: [n(1), n(2)] }); cx = n(1); cy = n(2); sx = cx; sy = cy }
    else if (c === 'L') { cmds.push({ command: 'lineTo', args: [n(1), n(2)] }); cx = n(1); cy = n(2) }
    else if (c === 'H') { cmds.push({ command: 'lineTo', args: [n(1), cy] }); cx = n(1) }
    else if (c === 'V') { cmds.push({ command: 'lineTo', args: [cx, n(1)] }); cy = n(1) }
    else if (c === 'Q') { cmds.push({ command: 'quadraticCurveTo', args: [n(1), n(2), n(3), n(4)] }); cx = n(3); cy = n(4) }
    else if (c === 'C') { cmds.push({ command: 'bezierCurveTo', args: [n(1), n(2), n(3), n(4), n(5), n(6)] }); cx = n(5); cy = n(6) }
    else if (c === 'Z') { cmds.push({ command: 'closePath', args: [] }); cx = sx; cy = sy }
  })
  return cmds
}

/** A stroke as an outline: every sub-path widened by `width` with round joins and caps. */
function strokeOutline(cmds: PathCommand[], width: number, tolerance: number): Ring[] {
  const out = new ClipperLib.Paths()
  const co = new ClipperLib.ClipperOffset(2, Math.max(1, (tolerance * SCALE) / 4))
  // reflatten keeping the open/closed state of each sub-path
  let cur: Array<{ X: number; Y: number }> = []
  let cx = 0, cy = 0
  const push = (x: number, y: number): void => { cur.push({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }); cx = x; cy = y }
  const flush = (closed: boolean): void => { if (cur.length >= 2) co.AddPath(cur, ClipperLib.JoinType.jtRound, closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound); cur = [] }
  for (const c of cmds) {
    const a = c.args
    if (c.command === 'moveTo') { flush(false); push(a[0] as number, a[1] as number) }
    else if (c.command === 'lineTo') push(a[0] as number, a[1] as number)
    else if (c.command === 'quadraticCurveTo') {
      const x0 = cx, y0 = cy
      const n = Math.max(4, Math.ceil(Math.sqrt(Math.hypot(x0 - 2 * (a[0] as number) + (a[2] as number), y0 - 2 * (a[1] as number) + (a[3] as number)) / (4 * tolerance))))
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; push(u * u * x0 + 2 * u * t * (a[0] as number) + t * t * (a[2] as number), u * u * y0 + 2 * u * t * (a[1] as number) + t * t * (a[3] as number)) }
    } else if (c.command === 'bezierCurveTo') {
      const x0 = cx, y0 = cy
      const d = Math.max(Math.hypot(x0 - 2 * (a[0] as number) + (a[2] as number), y0 - 2 * (a[1] as number) + (a[3] as number)), Math.hypot((a[0] as number) - 2 * (a[2] as number) + (a[4] as number), (a[1] as number) - 2 * (a[3] as number) + (a[5] as number)))
      const n = Math.max(4, Math.ceil(Math.sqrt((0.75 * d) / tolerance)))
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t
        push(u * u * u * x0 + 3 * u * u * t * (a[0] as number) + 3 * u * t * t * (a[2] as number) + t * t * t * (a[4] as number), u * u * u * y0 + 3 * u * u * t * (a[1] as number) + 3 * u * t * t * (a[3] as number) + t * t * t * (a[5] as number))
      }
    } else if (c.command === 'closePath') { const first = cur[0]; flush(true); if (first) { cx = first.X / SCALE; cy = first.Y / SCALE } }
  }
  flush(false)
  co.Execute(out, (width * SCALE) / 2)
  return out.map(p => p.map((q): [number, number] => [q.X / SCALE, q.Y / SCALE])).filter(r => r.length >= 3)
}
