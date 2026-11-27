// The code of `org.ateliermesh.voronoi`. Loaded on first use (see voronoi-plugin.ts).
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { embossRings } from './emboss/embosscore'
import { voronoiPattern } from './voronoi/pattern'
import { voronoiShell } from './voronoi/shell'
import { decimateAuto } from './decimate-wasm'

const FIT_CODES = ['emboss.touches_patch_edge', 'emboss.too_much_stretch', 'emboss.fold_over', 'emboss.patch_not_disk', 'emboss.curvature_collapse']

async function voronoi(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'voronoi' })
  const p = ctx.params
  const placement = p['placement'] as { anchor: { point: number[]; normal: number[] }; up_ref?: 'x' | 'y' | 'z'; direction?: number } | null
  if (!placement) throw new MeshError('voronoi.no_placement')
  ctx.progress('pattern', 0)
  const preview = ctx.quality === 'preview'
  const pat = voronoiPattern({
    region: p['region'] as 'rectangle' | 'circle', width: p['width'] as number, height: p['height_area'] as number, radius: p['radius'] as number,
    margin: p['margin'] as number, cells: p['cells'] as number, seed: p['seed'] as number, irregularity: p['irregularity'] as number,
    lineWidth: p['line_width'] as number, fill: p['fill'] as boolean, rounding: p['rounding'] as number, tolerance: preview ? 0.05 : 0.02, signal: ctx.signal,
  })
  ctx.progress('pattern', 1)
  ctx.progress('unfold', 0.2)
  const upRef: [number, number, number] = placement.up_ref === 'x' ? [1, 0, 0] : placement.up_ref === 'y' ? [0, 1, 0] : [0, 0, 1]
  const base = {
    mesh, point: placement.anchor.point as [number, number, number], normal: placement.anchor.normal as [number, number, number], rings: pat.rings, bbox: pat.bbox,
    height: p['height'] as number, mode: p['mode'] as 'raised' | 'engraved' | 'flat', direction: placement.direction ?? 0, upRef,
    segment: (p['segment'] as string) === '' ? null : (p['segment'] as string), wallsSegment: ((p['walls_segment'] as string | undefined) ?? '') === '' ? null : (p['walls_segment'] as string),
    minWall: p['min_wall'] as number, signal: ctx.signal,
  }
  // a wide region on a gently curved surface only needs a band; fall back to a disk when the band does not unfold well
  let res
  try {
    if (pat.bbox[2] - pat.bbox[0] > 25) {
      try { res = embossRings({ ...base, patch: 'band' }) } catch (e) { if (!(e instanceof MeshError) || !FIT_CODES.includes(e.code)) throw e }
    }
    res ??= embossRings({ ...base, patch: 'disk' })
  } catch (e) {
    // the cutter's messages are about text; say it in the pattern's own words and keep the cutter's code as the reason
    if (e instanceof MeshError && FIT_CODES.includes(e.code)) throw new MeshError('voronoi.does_not_fit', { reason: e.code, ...e.params }, e.path)
    throw e
  }
  ctx.progress('cut', 1)
  const warnings: StructuredError[] = [...res.warnings]
  const min = p['min_stroke'] as number
  if (pat.meanStroke < min) warnings.push({ code: 'voronoi.thin_lines', params: { stroke: pat.meanStroke, min, ...(p['fill'] ? {} : { min_line: Math.ceil(min * 10) / 10 }) } })
  return {
    mesh: res.mesh, warnings,
    report: { ...res.report, cells: pat.cells, cells_kept: pat.cellsKept, cell_size: pat.cellSize, mean_stroke: pat.meanStroke, pattern_vertices: pat.vertices, seed: p['seed'] },
  }
}

/** Thinnest strut or wall that prints reliably with a 0.4 mm nozzle; below it the step warns. */
const MIN_PRINTABLE = 0.8
/** Smooth-maximum width per unit of the thinnest side that turns the edges of a strut into fillets of half that side. */
const BEAM_K = 0.6
const DETAIL_FACTOR = { extra_fine: 0.5, fine: 0.7, auto: 1, coarse: 1.6 }

async function voronoiShellOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'voronoi_shell' })
  const p = ctx.params
  if (mesh.groups && mesh.groups.length > 1) throw new MeshError('voronoi_shell.groups_unsupported', { groups: mesh.groups.length })
  const thickness = p['thickness'] as number, rib = p['rib_width'] as number
  const detail = p['detail'] as 'auto' | 'fine' | 'extra_fine' | 'coarse'
  const round = (p['beam_rounding'] as number | undefined) ?? 0
  // rounding the beams: the smooth maximum of the wall and the strut raises the field by k/4 at a square edge, which cuts a fillet of about 0.85 k, so a
  // roundness of 1 (every edge a fillet of half the thinnest side) takes k = BEAM_K times that side. 0 keeps the plain `smooth` value.
  const thin = Math.min(rib, thickness)
  const smooth = round > 0 ? round * BEAM_K * thin : (p['smooth'] as number)
  // a voxel is a third of the thinnest feature (strut or wall), a quarter when the beams are rounded so the fillets have voxels to be drawn in; a preview uses voxels twice as big
  const fineVoxel = Math.min(4, Math.max(0.15, thin / (3 + (round > 0 ? 1 : 0)))) * DETAIL_FACTOR[detail]
  // a preview uses voxels 1.4 times as big (twice as big left the struts, about 1.5 voxels wide, ragged: 4.9 % of the edges bent more than 60 degrees against 0.7 %)
  const voxel = fineVoxel * (ctx.quality === 'preview' ? 1.4 : 1)
  const before = measureMesh(mesh)
  if (!before.watertight) throw new MeshError('voronoi_shell.bad_input', { reason: 'not_closed' })
  const r = voronoiShell(mesh, {
    thickness, cells: p['cells'] as number, seed: p['seed'] as number, irregularity: p['irregularity'] as number, ribWidth: rib, smooth,
    opening: p['opening'] as 'none' | 'bottom' | 'top' | 'both', openingDiameter: p['opening_diameter'] as number, voxel, signal: ctx.signal,
    onProgress: (stage, f) => ctx.progress(stage, f),
  })
  if (r.rawTriangles === 0) throw new MeshError('voronoi_shell.empty_result', {})
  const warnings: StructuredError[] = []
  if (rib < MIN_PRINTABLE) warnings.push({ code: 'voronoi_shell.thin_ribs', params: { width: rib, min: MIN_PRINTABLE } })
  if (thickness < MIN_PRINTABLE) warnings.push({ code: 'voronoi_shell.thin_wall', params: { width: thickness, min: MIN_PRINTABLE } })
  if (r.noCavity) warnings.push({ code: 'voronoi_shell.thickness_too_big', params: { thickness, depth: Math.round(r.maxDepth * 10) / 10 } })
  let out = r.mesh
  let decimated = false
  const cap = p['max_triangles'] as number
  if (r.rawTriangles > cap) {
    // more detail than asked for: reduce it, keeping the borders of the openings
    const d = await decimateAuto(out, { targetTriangles: cap, preserveBoundary: true, preserveCreases: false, signal: ctx.signal })
    out = d.mesh; decimated = true
  }
  const m = measureMesh(out)
  return {
    mesh: out, warnings,
    report: {
      voxel_mm: Math.round(voxel * 1000) / 1000, grid: r.grid, grid_cells: r.gridCells, band_voxels: r.bandVoxels, cells: r.seeds, cell_spacing_mm: Math.round(r.spacing * 100) / 100,
      surface_area_mm2: Math.round(r.area), triangles_raw: r.rawTriangles, triangles: out.indices.length / 3, decimated, thickness_mm: thickness, rib_width_mm: rib,
      max_depth_mm: Math.round(r.maxDepth * 10) / 10, volume_before: Math.round(before.volume * 100) / 100, volume_after: Math.round(m.volume * 100) / 100, closed: m.watertight,
      seed: p['seed'], timing_ms: r.ms,
    },
  }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'voronoi': return voronoi(ctx)
      case 'voronoi_shell': return voronoiShellOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
