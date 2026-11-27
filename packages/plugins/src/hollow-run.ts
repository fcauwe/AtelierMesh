// The code of `org.ateliermesh.hollow`. Loaded on first use (see hollow-plugin.ts).
import { MeshError, measureMesh } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { hollowMesh } from './hollow'
import { decimateAuto } from './decimate-wasm'

/** Thinnest wall that prints reliably with a 0.4 mm nozzle; below it the step warns. */
const MIN_PRINTABLE = 0.8
const DETAIL_FACTOR = { fine: 0.7, auto: 1, coarse: 1.6 }

async function hollowOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'hollow' })
  const p = ctx.params
  const thickness = p['thickness'] as number
  const detail = p['detail'] as 'auto' | 'fine' | 'coarse'
  const opening = p['opening'] as 'none' | 'bottom' | 'top' | 'both'
  const cavitySegment = (p['cavity_segment'] as string) ?? ''
  // a voxel is a third of the wall; a preview uses voxels twice as big.
  const voxel = Math.min(4, Math.max(0.15, thickness / 3)) * DETAIL_FACTOR[detail] * (ctx.quality === 'preview' ? 2 : 1)
  const before = measureMesh(mesh)
  if (!before.watertight) throw new MeshError('hollow.bad_input', { reason: 'not_closed' })
  const r = hollowMesh(mesh, {
    thickness, opening, openingDiameter: p['opening_diameter'] as number, smooth: p['smooth'] as number, voxel, cavitySegment, signal: ctx.signal,
    onProgress: (stage, f) => ctx.progress(stage, f),
  })
  const warnings: StructuredError[] = []
  if (thickness < MIN_PRINTABLE) warnings.push({ code: 'hollow.thin_walls', params: { width: thickness, min: MIN_PRINTABLE } })
  if (!r.hollowed) {
    // the model is thinner than the wall everywhere: there is no room for a cavity, and the model comes back as it was
    warnings.push({ code: 'hollow.thickness_too_big', params: { thickness, depth: Math.round(r.maxDepth * 10) / 10 } })
    return { mesh, warnings, report: { hollowed: false, thickness_mm: thickness, max_depth_mm: Math.round(r.maxDepth * 10) / 10, voxel_mm: Math.round(voxel * 1000) / 1000, triangles: mesh.indices.length / 3, volume_before: Math.round(before.volume * 100) / 100, volume_after: Math.round(before.volume * 100) / 100, closed: true, timing_ms: r.ms } }
  }
  if (r.remeshed) warnings.push({ code: 'hollow.outer_remeshed', params: {} })
  let out = r.mesh
  let decimated = false
  const cap = p['max_triangles'] as number
  if (r.remeshed && out.indices.length / 3 > cap) {
    // more detail than asked for: reduce it, keeping the borders of the opening
    const d = await decimateAuto(out, { targetTriangles: cap, preserveBoundary: true, preserveCreases: false, signal: ctx.signal })
    out = d.mesh; decimated = true
  }
  const m = measureMesh(out)
  return {
    mesh: out, warnings,
    report: {
      hollowed: true, outer_remeshed: r.remeshed, thickness_mm: thickness, voxel_mm: Math.round(voxel * 1000) / 1000, grid: r.grid, grid_cells: r.gridCells, band_voxels: r.bandVoxels,
      triangles_before: mesh.indices.length / 3, triangles: out.indices.length / 3, cavity_triangles: r.cavityTriangles, decimated, dropped_bubbles: r.droppedBubbles,
      volume_before: Math.round(before.volume * 100) / 100, volume_after: Math.round(m.volume * 100) / 100,
      cavity_volume: r.cavityVolume === null ? null : Math.round(r.cavityVolume * 100) / 100,
      wall_min_mm: r.wall ? Math.round(r.wall.min * 1000) / 1000 : null, wall_mean_mm: r.wall ? Math.round(r.wall.mean * 1000) / 1000 : null,
      max_depth_mm: Math.round(r.maxDepth * 10) / 10, closed: m.watertight, timing_ms: r.ms,
    },
  }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'hollow': return hollowOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
