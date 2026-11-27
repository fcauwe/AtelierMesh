// The code of `org.ateliermesh.lowpoly`. Loaded on first use (see lowpoly-plugin.ts).
import { MeshError } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { facets } from './facets/facets'
import type { FacetParams } from './facets/facets'
import { AUTO_MIN_TRIANGLES, autoTolerance, lowPoly, volumeChangePercent } from './lowpoly'

/** A change in volume beyond this share (percent) is worth a warning: the printed part will weigh and fit differently. */
const VOLUME_WARN = 15

/** The Even facets style: a mosaic of even triangles with a random in-and-out jitter (src/facets/facets.ts; docs/facets-method.md). */
function evenFacetsOp(ctx: RunContext) {
  const mesh = ctx.mesh!
  const r = facets(mesh, ctx.params as unknown as FacetParams, { isCancelled: () => ctx.signal.aborted, progress: (stage, f) => ctx.progress(stage, f) })
  return { mesh: r.mesh, warnings: r.warnings, report: { style: 'facets', ...r.report } }
}

async function lowPolyOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'low_poly' })
  const p = ctx.params
  if (p['style'] === 'facets') return evenFacetsOp(ctx)
  // a step stored before the setting existed has no mode and is a fixed count (`migrate` writes that; this is the same rule for a step that skipped it)
  const auto = (p['triangles_mode'] ?? 'fixed') === 'auto'
  const detail = typeof p['detail'] === 'number' ? p['detail'] : 0.5
  const tolerance = auto ? autoTolerance(mesh, detail) : 0
  const target = auto ? AUTO_MIN_TRIANGLES : (p['triangles'] as number)
  const r = await lowPoly(mesh, {
    triangles: target, ...(auto ? { autoTolerance: tolerance } : {}), sharpness: p['sharpness'] as number, crystallise: p['crystallise'] as number, keepBorders: p['keep_borders'] as boolean,
    signal: ctx.signal, onProgress: (stage, f) => ctx.progress(stage, f),
  })
  const warnings: StructuredError[] = []
  if (r.unchanged) {
    warnings.push({ code: 'lowpoly.already_smaller', params: { triangles: r.before, target } })
    return { mesh, warnings, report: { triangles_before: r.before, triangles_after: r.after, volume_change_percent: 0, unchanged: true } }
  }
  // held creases and borders can stop the collapse before the target
  if (!auto && r.after > Math.max(target * 1.1, target + 8)) warnings.push({ code: 'lowpoly.target_not_reached', params: { target, triangles: r.after } })
  const vol = volumeChangePercent(mesh, r.mesh)
  if (vol && Math.abs(vol.percent) > VOLUME_WARN) warnings.push({ code: 'lowpoly.volume_changed', params: { percent: Math.round(vol.percent * 10) / 10 } })
  return {
    mesh: r.mesh, warnings,
    report: {
      triangles_before: r.before, triangles_after: r.after, volume_change_percent: vol ? Math.round(vol.percent * 100) / 100 : null,
      mode: auto ? 'auto' : 'fixed', ...(auto ? { detail, tolerance: Math.round(tolerance * 1000) / 1000, chosen_triangles: r.after } : {}),
      max_error: r.maxError, engine: r.engine, creases: r.creases, moved: r.moved, max_move: r.maxMove, unchanged: false,
    },
  }
}

const module_: PluginModule = {
  /** Version 0.1.0 had only a fixed count: a stored step without the mode stays fixed. Before 0.3.0 there was only the reduce style. */
  migrate(_from: string, params: Record<string, unknown>, op: string) {
    if (op !== 'low_poly') return params
    const out: Record<string, unknown> = params['triangles_mode'] === undefined ? { ...params, triangles_mode: 'fixed' } : { ...params }
    if (out['style'] === undefined) out['style'] = 'reduce'
    return out
  },
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'low_poly': return lowPolyOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
