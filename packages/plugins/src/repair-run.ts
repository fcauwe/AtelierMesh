// The code of `org.ateliermesh.repair`. Loaded on first use (see repair-plugin.ts).
import { MeshError } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { repairMesh } from './repair'

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d

function repairOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'repair_mesh' })
  const p = ctx.params
  const r = repairMesh(mesh, {
    weld: p['weld'] as number, nonManifold: p['non_manifold'] as 'split' | 'remove' | 'off', fixNormals: p['fix_normals'] as boolean,
    minIsland: p['min_island'] as number, maxHole: p['max_hole'] as number,
    signal: ctx.signal, onProgress: (stage, f) => ctx.progress(stage, f),
  })
  const warnings: StructuredError[] = []
  const d = r.did
  if (d.holesTooBig > 0) warnings.push({ code: 'repair.hole_too_big', params: { count: d.holesTooBig, largest: r.largestTooBig, max: p['max_hole'] as number } })
  if (d.holesSkipped > 0) warnings.push({ code: 'repair.hole_skipped', params: { count: d.holesSkipped } })
  if (!r.after.closed) warnings.push({ code: 'repair.still_open', params: { holes: r.after.holes, edges: r.after.boundaryEdges + r.after.nonManifoldEdges } })
  const did: string[] = []
  if (d.welded > 0) did.push('weld')
  if (d.degenerate + d.duplicates > 0) did.push('clean')
  if (d.nonManifoldEdges > 0) did.push('non_manifold')
  if (d.flipped > 0) did.push('winding')
  if (d.islandsRemoved > 0) did.push('islands')
  if (d.holesFilled > 0) did.push('holes')
  const vb = r.before.volume, va = r.after.volume
  return {
    mesh: r.mesh, warnings,
    report: {
      unchanged: r.unchanged, closed: r.after.closed, did,
      vertices_before: r.before.vertices, vertices_after: r.after.vertices, triangles_before: r.before.triangles, triangles_after: r.after.triangles,
      shells_before: r.before.shells, shells_after: r.after.shells, holes_before: r.before.holes, holes_after: r.after.holes,
      non_manifold_edges_before: r.before.nonManifoldEdges, non_manifold_edges_after: r.after.nonManifoldEdges,
      boundary_edges_before: r.before.boundaryEdges, boundary_edges_after: r.after.boundaryEdges,
      volume_before: vb === null ? null : round(vb), volume_after: va === null ? null : round(va),
      volume_change_percent: vb !== null && va !== null && vb !== 0 ? round(((va - vb) / Math.abs(vb)) * 100) : null,
      welded_vertices: d.welded, dropped_degenerate: d.degenerate, dropped_duplicates: d.duplicates, non_manifold_fixed: d.nonManifoldEdges,
      flipped_triangles: d.flipped, islands_removed: d.islandsRemoved, island_triangles: d.islandTriangles,
      holes_filled: d.holesFilled, hole_triangles: d.holeTriangles, holes_too_big: d.holesTooBig, holes_skipped: d.holesSkipped,
    },
  }
}

const module_: PluginModule = {
  run(op: string, ctx: RunContext) {
    switch (op) {
      case 'repair_mesh': return repairOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
