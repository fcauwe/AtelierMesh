// The code of `org.ateliermesh.texture`. Loaded on first use (see texture-plugin.ts).
import { MeshError, measureMesh, selectPart } from '@ateliermesh/core'
import type { PluginModule, RunContext, StructuredError } from '@ateliermesh/core'
import { textureMesh, textureVolumeChange } from './texture'
import type { Mapping, TextureOptions } from './texture'
import { decodeHeightImage } from './texture/image'
import type { HeightImage } from './texture/image'
import { PATTERNS } from './texture/patterns'
import type { PatternName } from './texture/patterns'

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Faces within this angle of straight down count as the bottom. */
const BOTTOM_ANGLE_DEG = 20

/** The region without the triangles that face down (null region = the whole mesh); the same array when nothing faces down. */
function withoutBottom(mesh: { positions: Float64Array; indices: Uint32Array }, region: Uint8Array | null): Uint8Array | null {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3
  const limit = -Math.cos((BOTTOM_ANGLE_DEG * Math.PI) / 180)
  const out = new Uint8Array(nt)
  let any = false
  for (let t = 0; t < nt; t++) {
    if (region && !region[t]) continue
    const a = 3 * (I[3 * t] as number), b = 3 * (I[3 * t + 1] as number), c = 3 * (I[3 * t + 2] as number)
    const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number), uz = (P[b + 2] as number) - (P[a + 2] as number)
    const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number), vz = (P[c + 2] as number) - (P[a + 2] as number)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0 && nz / len < limit) { any = true; continue }   // faces down: left out
    out[t] = 1
  }
  return any ? out : region
}

async function textureOp(ctx: RunContext) {
  const mesh = ctx.mesh
  if (!mesh) throw new MeshError('input.missing_mesh', { op: 'texture' })
  const p = ctx.params
  const pattern = (PATTERNS as readonly string[]).includes(p['pattern'] as string) ? (p['pattern'] as PatternName) : 'knurl'
  let image: HeightImage | null = null
  if (pattern === 'image' && num(p['amplitude'], 0) !== 0) {
    if (typeof p['image'] !== 'string' || p['image'] === '') throw new MeshError('texture.no_image', {})
    image = await decodeHeightImage(await ctx.assets(p['image'] as string))
  }
  let region = typeof p['region'] === 'string' ? selectPart(mesh, p['region'] as string, ['segment', 'group']) : null
  if (p['skip_bottom'] === true) region = withoutBottom(mesh, region)
  const o: TextureOptions = {
    pattern, amplitude: num(p['amplitude'], 0.6), scale: Math.max(0.1, num(p['scale'], 5)), offset: num(p['offset'], 0),
    pattern_params: { seed: Math.round(num(p['seed'], 1)), roughness: num(p['roughness'], 0.5), octaves: Math.round(num(p['octaves'], 3)), fill: num(p['fill'], 0.5) },
    invert: p['invert'] === true, image, tiling: p['tiling'] === 'fit' ? 'fit' : 'tile',
    mapping: (['triplanar', 'planar', 'cylindrical', 'spherical', 'box'].includes(p['mapping'] as string) ? p['mapping'] : 'triplanar') as Mapping,
    axis: (['x', 'y', 'z'].includes(p['axis'] as string) ? p['axis'] : 'z') as 'x' | 'y' | 'z', blend: Math.max(1, num(p['blend'], 4)),
    rotation: num(p['rotation'], 0), offsetU: num(p['offset_u'], 0), offsetV: num(p['offset_v'], 0),
    region, falloff: Math.max(0, num(p['edge_falloff'], 1)), segmentName: typeof p['segment'] === 'string' ? (p['segment'] as string) : '',
    detail: p['detail'] === 'fine' || p['detail'] === 'coarse' ? (p['detail'] as 'fine' | 'coarse') : 'auto', maxTriangles: Math.round(num(p['max_triangles'], 1000000)),
    smoothNormals: p['smooth_normals'] !== false, signal: ctx.signal, onProgress: (stage, f) => ctx.progress(stage, f),
  }
  const r = textureMesh(mesh, o)
  const warnings: StructuredError[] = []
  if (!r.identity && (r.flipped > 0 || r.tight > 0)) warnings.push({ code: 'texture.may_self_intersect', params: { turned: r.flipped, tight: r.tight, amplitude: Math.abs(o.amplitude) } })
  const m = measureMesh(r.mesh)
  const vol = r.identity ? 0 : textureVolumeChange(mesh, r.mesh)
  return {
    mesh: r.mesh, warnings,
    report: {
      pattern, amplitude_mm: o.amplitude, scale_mm: o.scale, triangles_before: r.before, triangles_after: r.after, textured_triangles: r.textured,
      edge_length_mm: Math.round(r.edgeLength * 1000) / 1000, max_displacement_mm: Math.round(r.maxDisplacement * 1000) / 1000,
      volume_change_percent: vol === null ? null : Math.round(vol * 100) / 100, closed: m.watertight, turned_triangles: r.flipped,
    },
  }
}

const module_: PluginModule = {
  async run(op: string, ctx: RunContext) {
    switch (op) {
      case 'texture': return textureOp(ctx)
      default: throw new MeshError('step.unknown_op', { op })
    }
  },
}

export default module_
