// The code of `org.ateliermesh.parts`. Loaded on first use (see parts-plugin.ts).
import { MeshError } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { removeParts } from './parts'

function partsOp(mode: 'delete' | 'keep', ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: mode === 'delete' ? 'delete_part' : 'keep_part' })
  const p = ctx.params
  const r = removeParts(mesh, {
    part: typeof p['part'] === 'string' ? (p['part'] as string) : '', mode,
    closeHole: p['close_hole'] === 'none' ? 'none' : 'fill', removeUnused: p['remove_unused'] !== false,
    signal: ctx.signal, onProgress: (stage, f) => ctx.progress(stage, f),
  })
  const warnings: StructuredError[] = []
  if (r.capsSkipped > 0) warnings.push({ code: 'parts.cap_skipped', params: { count: r.capsSkipped } })
  if (r.closedBefore && !r.closedAfter) warnings.push({ code: 'parts.result_open', params: { part: r.name } })
  return {
    mesh: r.mesh, warnings,
    report: {
      mode, kind: r.kind, part: r.name,
      triangles_before: r.trianglesBefore, triangles_after: r.trianglesAfter, removed_triangles: r.removed, cap_triangles: r.capTriangles,
      closed_before: r.closedBefore, closed: r.closedAfter,
      segments_removed: r.segmentsGone, groups_removed: r.groupsGone,
    },
  }
}

const module_: PluginModule = {
  run(op: string, ctx: RunContext) {
    switch (op) {
      case 'delete_part': return partsOp('delete', ctx)
      case 'keep_part': return partsOp('keep', ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
