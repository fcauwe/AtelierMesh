// An example plugin: mirror a mesh across a plane through the middle of its bounding box.
// A plugin is one ES module whose default export has a `run(op, ctx)` function. It must not import anything it does not bundle,
// must not change `ctx.mesh`, and returns a new mesh. Mirroring turns triangles inside out, so the winding is flipped back.
interface Mesh { positions: Float64Array; indices: Uint32Array; segments?: { labels: Uint16Array; table: Array<{ id: number; name: string }> } }
interface Ctx { mesh?: Mesh; params: Record<string, unknown>; progress(stage: string, fraction: number): void }

export default {
  async run(op: string, ctx: Ctx): Promise<{ mesh: Mesh; report: Record<string, unknown> }> {
    if (op !== 'mirror') throw new Error(`unknown operation ${op}`)
    const mesh = ctx.mesh
    if (!mesh) throw new Error('mirror needs a mesh')
    const axis = ['x', 'y', 'z'].indexOf(ctx.params['axis'] as string)
    const p = mesh.positions.slice()
    let lo = Infinity, hi = -Infinity
    for (let i = axis; i < p.length; i += 3) { const v = p[i] as number; if (v < lo) lo = v; if (v > hi) hi = v }
    for (let i = axis; i < p.length; i += 3) p[i] = lo + hi - (p[i] as number)
    const indices = mesh.indices.slice()
    for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1] as number; indices[i + 1] = indices[i + 2] as number; indices[i + 2] = t }
    ctx.progress('mirror', 1)
    return { mesh: { positions: p, indices, ...(mesh.segments ? { segments: mesh.segments } : {}) }, report: { plane: (lo + hi) / 2 } }
  },
}
