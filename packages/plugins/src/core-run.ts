// The code of the operations of `org.ateliermesh.core`. Loaded on first use (see core-plugin.ts).
import { MeshError, compareSemver, measureMesh } from '@ateliermesh/core'
import type { Drawing, PluginModule, RunContext } from '@ateliermesh/core'
import { aroundPivot, multiply, pivotPoint, rotation, scaling, scalingXYZ, transformMesh, translation } from './geometry'
import { bestCandidate, orientCandidates } from './orient'
import type { OrientGoal } from './orient'
import { flagRuns, overhangForUp } from './overhang'
import { embossRings } from './emboss/embosscore'
import { layoutText } from './emboss/text'
import { getFont } from './emboss/outlines'
import type { Font } from 'fontkit'
import { drawingToShape } from './emboss/svg'
import { fillArea } from './emboss/shape'
import { decimateAuto } from './decimate-wasm'
import type { Matrix, PivotKind } from './geometry'

const sizeOf = (mesh: Parameters<typeof measureMesh>[0]): number[] => measureMesh(mesh).size.slice()

function resize(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'resize' })
  const p = ctx.params
  const before = sizeOf(mesh)
  // one factor per direction: the same for all three (the usual), or different ones (a stretch in one direction only)
  let f: [number, number, number]
  if (p['mode'] === 'target_size') {
    const axis = ['x', 'y', 'z'].indexOf(p['target_axis'] as string)
    const current = before[axis] as number
    if (!(current > 1e-9)) throw new MeshError('resize.zero_size', { axis: p['target_axis'] as string })
    const k = (p['target_mm'] as number) / current
    f = p['keep_proportions'] === false ? [axis === 0 ? k : 1, axis === 1 ? k : 1, axis === 2 ? k : 1] : [k, k, k]
  } else if (p['mode'] === 'per_axis') {
    f = [(p['percent_x'] as number) / 100, (p['percent_y'] as number) / 100, (p['percent_z'] as number) / 100]
  } else { const k = (p['percent'] as number) / 100; f = [k, k, k] }
  const uniform = f[0] === f[1] && f[1] === f[2]
  // the one number other steps and hints use ("the letters grow by this much"): the factor, or for a stretch the mean over the three directions
  const factor = uniform ? f[0] : Math.cbrt(f[0] * f[1] * f[2])
  const pivot = pivotPoint(mesh, p['pivot'] as PivotKind, p['pivot_point'] as number[])
  const matrix: Matrix = aroundPivot(uniform ? scaling(f[0]) : scalingXYZ(f[0], f[1], f[2]), pivot)
  const out = transformMesh(mesh, matrix)
  ctx.progress('resize', 1)
  return { mesh: out, report: { factor, factors: f, uniform, matrix, pivot, size_before: before, size_after: sizeOf(out) } }
}

function rotate(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'rotate' })
  const p = ctx.params
  const snap = p['snap_step'] as number
  const angles = (p['angles'] as number[]).map(a => (snap > 0 ? Math.round(a / snap) * snap : a))
  // "XYZ" means: turn about world X first, then Y, then Z
  let r: Matrix = rotation('X', 0)
  for (const axis of (p['order'] as string).split('') as Array<'X' | 'Y' | 'Z'>) r = multiply(rotation(axis, angles['XYZ'.indexOf(axis)] as number), r)
  const pivot = pivotPoint(mesh, p['pivot'] as PivotKind, p['pivot_point'] as number[])
  const matrix = aroundPivot(r, pivot)
  const out = transformMesh(mesh, matrix)
  ctx.progress('rotate', 1)
  return { mesh: out, report: { matrix, pivot, angles, size_before: sizeOf(mesh), size_after: sizeOf(out) } }
}

async function decimateOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'decimate' })
  const p = ctx.params
  // "as small as possible" takes every collapse that moves the surface by no more than `tolerance`; "target number" stops at the number of triangles asked for
  const quality = p['mode'] !== 'target'
  const o = {
    targetTriangles: quality ? 4 : (p['target_triangles'] as number), maxError: quality ? (p['tolerance'] as number) : (p['max_error'] as number), preserveBoundary: p['preserve_boundary'] as boolean,
    preserveCreases: p['preserve_creases'] as boolean, creaseAngle: p['crease_angle'] as number, signal: ctx.signal, onProgress: (f: number) => ctx.progress('collapse', f),
  }
  // WebAssembly is much faster; the JavaScript version is the same algorithm and the fallback where WebAssembly is not available
  const r = await decimateAuto(mesh, o, p['engine'] as 'auto' | 'wasm' | 'js')
  return { mesh: r.mesh, report: { mode: quality ? 'quality' : 'target', triangles_before: r.before, triangles_after: r.after, max_error: r.maxError, collapses: r.collapses, engine: r.engine } }
}

function overhang(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'overhang' })
  const r = overhangForUp(mesh, [0, 0, 1], ctx.params['angle'] as number, { flags: true })
  const { runs, truncated } = flagRuns(r.flags as Uint8Array)
  ctx.progress('overhang', 1)
  return { report: { area: r.area, share: r.surface > 0 ? r.area / r.surface : 0, surface: r.surface, bed_area: r.bed_area, height: r.height, triangles: r.count, flagged_runs: runs, flagged_truncated: truncated } }
}

function autoOrient(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'auto_orient' })
  const p = ctx.params
  const candidates = orientCandidates(mesh, p['candidates'] as number, p['overhang_angle'] as number)
  const winner = bestCandidate(candidates, p['goal'] as OrientGoal)
  ctx.progress('auto_orient', 1)
  const best = candidates[winner] as (typeof candidates)[number]
  return { report: { goal: p['goal'], candidates, winner, rotate: { angles: best.angles, order: 'XYZ', pivot: 'bbox_center' } } }
}

/** Turns the model the best way up (the same search as the analyzer) and, unless told otherwise, puts its lowest point on the bed. */
function orientForPrint(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'orient' })
  const p = ctx.params
  const candidates = orientCandidates(mesh, p['candidates'] as number, p['overhang_angle'] as number)
  const winner = bestCandidate(candidates, p['goal'] as OrientGoal)
  const best = candidates[winner] as (typeof candidates)[number]
  ctx.progress('auto_orient', 0.8)
  let r: Matrix = rotation('X', 0)
  for (const axis of ['X', 'Y', 'Z'] as const) r = multiply(rotation(axis, best.angles['XYZ'.indexOf(axis)] as number), r)
  const pivot = pivotPoint(mesh, 'bbox_center' as PivotKind, [0, 0, 0])
  let out = transformMesh(mesh, aroundPivot(r, pivot))
  let lift = 0
  if (p['place_on_bed'] !== false) {
    let zmin = Infinity
    for (let i = 2; i < out.positions.length; i += 3) { const z = out.positions[i] as number; if (z < zmin) zmin = z }
    if (Number.isFinite(zmin) && Math.abs(zmin) > 1e-9) { lift = -zmin; out = transformMesh(out, translation([0, 0, lift])) }
  }
  ctx.progress('auto_orient', 1)
  const turned = best.angles.some(a => Math.abs(a) > 1e-6)
  return { mesh: out, report: { goal: p['goal'], winner, angles: best.angles, turned, lifted_by: lift, overhang_area: best.overhang_area, base_area: best.base_area, height: best.height, candidates: candidates.length, size_before: sizeOf(mesh), size_after: sizeOf(out) } }
}

const FIT_CODES = ['emboss.touches_patch_edge', 'emboss.too_much_stretch', 'emboss.fold_over']

async function emboss(ctx: RunContext, svgOp: boolean) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'emboss' })
  const p = ctx.params
  const placement = p['placement'] as { anchor: { point: number[]; normal: number[] }; up_ref?: 'x' | 'y' | 'z'; direction?: number; offset?: [number, number]; align?: { h: 'left' | 'center' | 'right'; v: 'baseline' | 'middle' } } | null
  if (!placement) throw new MeshError('emboss.no_placement', svgOp ? { svg: true } : {})
  ctx.progress('text', 0)
  const preview = ctx.quality === 'preview'
  const anchor = placement.align ?? { h: 'center' as const, v: 'middle' as const }
  const offset = placement.offset ?? [0, 0] as [number, number]
  type Shape = { rings: Array<Array<[number, number]>>; bbox: [number, number, number, number]; fitScale: number; size: number; lines: number }
  let layout: (scale: number) => Shape
  if (svgOp) {
    const drawing = ctx.payloads['shape'] as Drawing | undefined
    if (!drawing) throw new MeshError('emboss.no_shape')
    // the drawing is already flat and in millimetres: only the size, the width limit and the placement are applied here
    layout = scale => { const s = drawingToShape(drawing, { size: (p['size'] as number) * scale, maxWidth: p['max_width'] as number, anchor, offset }); return { ...s, lines: 1 } }
  } else {
    const fontId = p['font'] as string | null
    if (!fontId) throw new MeshError('emboss.no_font')
    // parsed fonts are cached by what the bytes are, not by the asset id: the same id may name different files in different projects
    const bytes = await ctx.assets(fontId)
    const font = (await getFont(bytes)) as Font
    layout = scale => layoutText(font, {
      text: p['text'] as string, size: (p['size'] as number) * scale, weight: p['weight'] as number, align: p['align'] as 'left' | 'center' | 'right',
      spacing: p['spacing'] as number, lineSpacing: p['line_spacing'] as number, maxWidth: p['max_width'] as number,
      tolerance: preview ? 0.05 : 0.01, anchor, offset,
    })
  }
  const cutAt = (shape: Shape) => {
    const upRef: [number, number, number] = placement.up_ref === 'x' ? [1, 0, 0] : placement.up_ref === 'y' ? [0, 1, 0] : [0, 0, 1]
    const base = {
      mesh, point: placement.anchor.point as [number, number, number], normal: placement.anchor.normal as [number, number, number], rings: shape.rings, bbox: shape.bbox,
      height: p['height'] as number, mode: p['mode'] as 'raised' | 'engraved' | 'flat', direction: placement.direction ?? 0, upRef,
      segment: (p['segment'] as string) === '' ? null : (p['segment'] as string), wallsSegment: ((p['walls_segment'] as string | undefined) ?? '') === '' ? null : (p['walls_segment'] as string), minWall: p['min_wall'] as number, signal: ctx.signal,
    }
    // a long text on a gently curved surface only needs a band; fall back to a disk when the band does not unfold well
    const width = shape.bbox[2] - shape.bbox[0]
    let res
    if (width > 25) {
      try { res = embossRings({ ...base, patch: 'band' }) } catch (e) {
        if (!(e instanceof MeshError) || !['emboss.too_much_stretch', 'emboss.patch_not_disk', 'emboss.fold_over', 'emboss.touches_patch_edge'].includes(e.code)) throw e
      }
    }
    res ??= embossRings({ ...base, patch: 'disk' })
    return { res, width }
  }
  // When the text does not fit, find a smaller size that does and say so in the error (`fit_size`, mm), so the page can offer it.
  const shape = layout(1)
  ctx.progress('unfold', 0.2)
  let out: ReturnType<typeof cutAt>
  try { out = cutAt(shape) } catch (e) {
    if (!(e instanceof MeshError) || !FIT_CODES.includes(e.code)) throw e
    for (const scale of [0.85, 0.7, 0.55, 0.4, 0.3, 0.2, 0.12]) {
      if (ctx.signal.aborted) throw e
      const smaller = layout(scale)
      try { cutAt(smaller) } catch (e2) { if (e2 instanceof MeshError && e2.code === 'run.cancelled') throw e2; continue }
      throw new MeshError(e.code, { ...e.params, fit_size: Math.floor(smaller.size * 10) / 10 }, e.path)
    }
    throw e
  }
  const { res, width } = out
  ctx.progress('cut', 1)
  const warnings = [...res.warnings]
  if (shape.fitScale < 1) warnings.push({ code: 'emboss.text_scaled_to_fit', params: { scale: shape.fitScale, size: shape.size } })
  if (shape.size < 1.5) warnings.push({ code: 'emboss.text_small', params: { size: shape.size, fit_size: 1.5 } })
  // the average width of the strokes: twice the area over the outline length. Thinner than the printer can lay down means the letters break up.
  let perimeter = 0
  for (const r of shape.rings) for (let i = 0; i < r.length; i++) { const a = r[i] as [number, number], b = r[(i + 1) % r.length] as [number, number]; perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]) }
  const stroke = perimeter > 0 ? (2 * Math.abs(fillArea(shape.rings))) / perimeter : 0
  if (stroke < (p['min_stroke'] as number)) warnings.push({ code: 'emboss.thin_strokes', params: { stroke, min: p['min_stroke'], ...(stroke > 0 ? { fit_size: Math.ceil((shape.size * (p['min_stroke'] as number) / stroke) * 10) / 10 } : {}) } })
  return { mesh: res.mesh, warnings, report: { ...res.report, text_width: width, text_height: shape.bbox[3] - shape.bbox[1], lines: shape.lines, size_used: shape.size, mean_stroke: stroke } }
}

const module_: PluginModule = {
  /** 0.1.0 -> 0.2.0: the text/SVG switch of `emboss` became two operations; an old SVG step is `emboss_svg` now. */
  migrateOp(_from, op, params) { return op === 'emboss' && params['source'] === 'svg' ? 'emboss_svg' : op },
  /** 0.2.0 -> 0.3.0: `decimate` got a method; a stored step has a target number, so it is "target number". */
  migrate(from, params, op) {
    if (op === 'decimate') return compareSemver(from, '0.3.0') < 0 && params['mode'] === undefined ? { ...params, mode: 'target' } : params
    // 0.3.0 -> 0.4.0: `emboss_svg` takes a drawing from the project store (`shape`), not an SVG file (`svg`, `svg_mode`). No saved step had an SVG, so the choice is left empty.
    if (op === 'emboss_svg' && compareSemver(from, '0.4.0') < 0) { const { svg: _svg, svg_mode: _mode, ...rest } = params; return { ...rest, shape: null } }
    if (op !== 'emboss' || compareSemver(from, '0.2.0') >= 0) return params
    const { source, svg: _svg, ...text } = params
    if (source !== 'svg') return text
    const { text: _t, font: _f, weight: _w, align: _a, spacing: _s, line_spacing: _l, ...rest } = text
    return { ...rest, shape: null }
  },
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'emboss': case 'emboss_svg': return emboss(ctx, op === 'emboss_svg')
      case 'decimate': return decimateOp(ctx)
      case 'overhang': return overhang(ctx)
      case 'auto_orient': return autoOrient(ctx)
      case 'orient': return orientForPrint(ctx)
      case 'resize': return resize(ctx)
      case 'rotate': return rotate(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
