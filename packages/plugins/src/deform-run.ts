// The code of `org.ateliermesh.deform`. Loaded on first use (see deform-plugin.ts).
import { MeshError } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { deformMesh, deformVolumeChange } from './deform'
import type { DeformOptions } from './deform'
import { pivotPoint } from './geometry'
import { measureMesh, selectPart } from '@ateliermesh/core'
import { smoothMesh } from './smooth'
import { fieldMesh, fieldVolumeChange } from './deform-field'
import type { FieldOptions } from './deform-field'

/** Warn when a surface line is stretched by more than this factor, or the map shrinks the cross-section below this share of its area. */
const STRETCH_WARN = 4
const JACOBIAN_WARN = 0.04

function deformOp(kind: 'twist' | 'taper' | 'bend') {
  return async (ctx: RunContext) => {
    const mesh = ctx.mesh
    if (!mesh) throw new MeshError('input.missing_mesh', { op: kind })
    const p = ctx.params
    const center = p['center'] === 'point' ? pivotPoint(mesh, 'point', p['center_point'] as number[]) : p['center'] === 'origin' ? pivotPoint(mesh, 'origin') : pivotPoint(mesh, 'bbox_center')
    const o: DeformOptions = {
      kind, axis: p['axis'] as 'x' | 'y' | 'z', center, from: p['from'] as number, to: p['to'] as number, easing: (p['easing'] ?? 'linear') as 'linear' | 'smooth',
      detail: p['detail'] as 'auto' | 'fine' | 'extra_fine' | 'coarse', maxTriangles: p['max_triangles'] as number, signal: ctx.signal, onProgress: f => ctx.progress('deform', f),
      ...(kind === 'twist' ? { angle: p['angle'] as number } : kind === 'bend' ? { angle: p['angle'] as number, bendAxis: p['bend_axis'] as 'x' | 'y' | 'z' } : { scaleEnd: p['scale_end'] as number, uniform: p['uniform'] as 'both' | 'x' | 'y' }),
    }
    if (kind === 'bend' && p['axis'] === p['bend_axis']) throw new MeshError('deform.bad_axes', { axis: p['axis'] })
    if (o.from >= o.to) throw new MeshError('deform.bad_range', { from: o.from, to: o.to })
    const r = deformMesh(mesh, o)
    const warnings: StructuredError[] = []
    if (!r.identity && ((kind !== 'bend' && r.minJacobian < JACOBIAN_WARN) || r.maxStretch > STRETCH_WARN || r.unresolved > 0)) {
      warnings.push({ code: 'deform.may_fold', params: { at: Math.round(r.worst * 100), stretch: Math.round(r.maxStretch * 10) / 10, scale: Math.round(Math.sqrt(Math.max(r.minJacobian, 0)) * 100) / 100, unresolved: r.unresolved } })
    }
    const m = measureMesh(r.mesh)
    const vol = deformVolumeChange(mesh, r.mesh)
    return {
      mesh: r.mesh, warnings,
      report: {
        triangles_before: r.before, triangles_after: r.after, slices: r.rounds, tolerance_mm: r.tolerance, max_displacement_mm: Math.round(r.maxDisplacement * 1000) / 1000,
        volume_change_percent: vol === null ? null : Math.round(vol * 100) / 100, closed: m.watertight, min_jacobian: r.minJacobian, max_stretch: Math.round(r.maxStretch * 100) / 100, unresolved_edges: r.unresolved,
      },
    }
  }
}


/** Warn when a wave that moves points along the surface normal is larger than this share of the smallest side of the model. */
const NORMAL_WARN = 0.25

function fieldOp(kind: 'wave' | 'ripple') {
  return async (ctx: RunContext) => {
    const mesh = ctx.mesh
    if (!mesh) throw new MeshError('input.missing_mesh', { op: kind })
    const p = ctx.params
    const center = p['center'] === 'point' ? pivotPoint(mesh, 'point', p['center_point'] as number[]) : p['center'] === 'origin' ? pivotPoint(mesh, 'origin') : pivotPoint(mesh, 'bbox_center')
    const o: FieldOptions = {
      kind, axis: p['axis'] as 'x' | 'y' | 'z', direction: (kind === 'wave' ? p['direction'] : 'z') as FieldOptions['direction'], center,
      wavelength: p['wavelength'] as number, amplitude: p['amplitude'] as number, phase: p['phase'] as number,
      from: kind === 'wave' ? (p['from'] as number) : 0, to: kind === 'wave' ? (p['to'] as number) : 1, falloff: kind === 'wave' ? (p['falloff'] as number) : 0,
      decay: kind === 'ripple' ? (p['decay'] as number) : 0, radius: kind === 'ripple' ? (p['radius'] as number) : 0,
      detail: p['detail'] as FieldOptions['detail'], maxTriangles: p['max_triangles'] as number, signal: ctx.signal, onProgress: f => ctx.progress('deform', f),
    }
    if (o.wavelength <= 0) throw new MeshError('deform.bad_wavelength', { wavelength: o.wavelength })
    if (o.from >= o.to) throw new MeshError('deform.bad_range', { from: o.from, to: o.to })
    const r = fieldMesh(mesh, o)
    const warnings: StructuredError[] = []
    const m = measureMesh(r.mesh)
    const side = Math.min(...measureMesh(mesh).size.filter(x => x > 1e-9))
    if (!r.identity && kind === 'wave' && o.direction === 'normal' && o.amplitude > NORMAL_WARN * side) {
      warnings.push({ code: 'deform.wave_too_big', params: { amplitude: o.amplitude, side: Math.round(side * 10) / 10 } })
    }
    const vol = fieldVolumeChange(mesh, r.mesh)
    return {
      mesh: r.mesh, warnings,
      report: {
        triangles_before: r.before, triangles_after: r.after, rounds: r.rounds, tolerance_mm: r.tolerance, edge_limit_mm: Math.round(r.edgeLimit * 1000) / 1000,
        max_displacement_mm: Math.round(r.maxDisplacement * 1000) / 1000, volume_change_percent: vol === null ? null : Math.round(vol * 100) / 100, closed: m.watertight, min_jacobian: r.minJacobian,
      },
    }
  }
}

/** Warn when smoothing moved a point by more than this share of the smallest side of the model, or changed the volume by more than this many percent. */
const THIN_MOVE = 0.2
const THIN_VOLUME = 5

async function smoothOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'smooth' })
  const p = ctx.params
  const part = p['part'] as string
  const region = part === '' ? null : selectPart(mesh, part, ['segment', 'group'])
  const r = smoothMesh(mesh, {
    iterations: p['iterations'] as number, strength: p['strength'] as number, keepEdges: p['keep_edges'] as number, keepBorders: p['keep_borders'] as boolean,
    keepVolume: p['keep_volume'] as boolean, maxMove: p['max_move'] as number, region, falloff: p['falloff'] as number, signal: ctx.signal,
    onProgress: f => ctx.progress('smooth', f),
  })
  const before = measureMesh(mesh)
  const after = r.identity ? before : measureMesh(r.mesh)
  const vol = before.watertight && before.volume > 1e-9 ? ((after.volume - before.volume) / before.volume) * 100 : null
  const warnings: StructuredError[] = []
  const side = Math.min(...before.size.filter(x => x > 1e-9))
  if (!r.identity && ((vol !== null && Math.abs(vol) > THIN_VOLUME) || r.maxDisplacement > THIN_MOVE * side)) {
    warnings.push({ code: 'smooth.thin_features', params: { change: vol === null ? 0 : Math.round(vol * 10) / 10, move: Math.round(r.maxDisplacement * 100) / 100 } })
  }
  return {
    mesh: r.mesh, warnings,
    report: {
      triangles: mesh.indices.length / 3, iterations: r.iterations, lambda: Math.round(r.lambda * 1000) / 1000, mu: Math.round(r.mu * 1000) / 1000,
      max_displacement_mm: Math.round(r.maxDisplacement * 1000) / 1000, mean_displacement_mm: Math.round(r.meanDisplacement * 1000) / 1000, volume_change_percent: vol === null ? null : Math.round(vol * 100) / 100,
      closed: after.watertight, moved_vertices: r.movable, fixed_vertices: r.fixed, crease_edges: r.creaseEdges, capped_vertices: r.capped, unchanged: r.identity, timing_ms: Math.round(r.ms),
    },
  }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'twist': return deformOp('twist')(ctx)
      case 'taper': return deformOp('taper')(ctx)
      case 'bend': return deformOp('bend')(ctx)
      case 'wave': return fieldOp('wave')(ctx)
      case 'ripple': return fieldOp('ripple')(ctx)
      case 'smooth': return smoothOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
