// The code of `org.ateliermesh.printcheck`. Loaded on first use (see printcheck-plugin.ts).
import { MeshError } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { printCheck } from './printcheck'

function printability(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'printability' })
  const p = ctx.params
  const bed = (Array.isArray(p['bed']) ? p['bed'] : [0, 0, 0]) as number[]
  const r = printCheck(mesh, {
    process: (p['process'] as 'fdm' | 'resin') ?? 'fdm', nozzle: (p['nozzle'] as number) ?? 0.4, layerHeight: (p['layer_height'] as number) ?? 0.2,
    minWall: (p['min_wall'] as number) ?? 0, minFeature: (p['min_feature'] as number) ?? 0, minGap: (p['min_gap'] as number) ?? 0,
    overhangAngle: (p['overhang_angle'] as number) ?? 45, bridgeLength: (p['bridge_length'] as number) ?? 10, minOverhangArea: (p['min_overhang_area'] as number) ?? 20,
    bed: [bed[0] ?? 0, bed[1] ?? 0, bed[2] ?? 0], quality: ctx.quality === 'preview' ? 'preview' : 'export', signal: ctx.signal, onProgress: (s, f) => ctx.progress(s, f),
  })
  // a finding that is a warning or an error becomes a warning of the step (an analyzer never blocks); the numbers are the ones of the finding
  const warnings: StructuredError[] = r.findings.filter(f => f.severity === 'warning' || f.severity === 'error').map(f => ({ code: f.code, params: { ...f.params, severity: f.severity } }))
  return { warnings, report: { ...r } }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'printability': return printability(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
