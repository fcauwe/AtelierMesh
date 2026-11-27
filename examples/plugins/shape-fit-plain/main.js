// Drawings and stored items, as plain JavaScript: ONE file, no imports, no build. Two operations:
//   block_from_drawing  takes a flat DRAWING (manifest: "payload": { "in": "drawing", "out": "mesh" }) and returns a block as big as the drawing.
//   fit_to_shape        takes a MESH and a stored drawing named by a setting of type "payload" (manifest: "accept": ["drawing"]) and scales the mesh to fit it.
// A drawing is { kind: 'drawing', paths: [{ points: [[x, y], ...], closed }], segments?, fillRule? } in millimetres, y up, curves already flattened.
//   ctx.payload      what the previous step produced: a drawing here (for a mesh it is the same object as ctx.mesh)
//   ctx.payloads     the stored items the settings ask for, by setting name: ctx.payloads.shape. Read only. Missing when the setting is empty (null).
// The engine has already checked the kind and the shape of both, so a plugin only reads them.

const problem = (code, params = {}) => ({ code, params })

function bounds(drawing) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const path of drawing.paths) for (const [x, y] of path.points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return x0 === Infinity ? null : [x0, y0, x1, y1]
}

// a box, 8 vertices and 12 triangles, counter-clockwise seen from outside
function box(x0, y0, z0, x1, y1, z1) {
  const positions = new Float64Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
  return { positions, indices }
}

export default {
  async run(op, ctx) {
    if (op === 'block_from_drawing') {
      const b = bounds(ctx.payload)
      if (!b || b[2] <= b[0] || b[3] <= b[1]) throw problem('block_from_drawing.empty')
      ctx.progress('block', 1)
      return { mesh: box(b[0], b[1], 0, b[2], b[3], ctx.params.height), report: { width: b[2] - b[0], depth: b[3] - b[1] } }
    }
    if (op === 'fit_to_shape') {
      const mesh = ctx.mesh
      if (!mesh) throw problem('input.missing_mesh', { op })
      const shape = ctx.payloads.shape
      if (!shape) throw problem('fit_to_shape.no_shape')
      const sb = bounds(shape)
      if (!sb || sb[2] <= sb[0] || sb[3] <= sb[1]) throw problem('fit_to_shape.empty_shape')
      const p = mesh.positions
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); z0 = Math.min(z0, p[i + 2]) }
      const w = x1 - x0, d = y1 - y0
      if (!(w > 0) || !(d > 0)) throw problem('fit_to_shape.flat_model')
      const room = [sb[2] - sb[0] - 2 * ctx.params.margin, sb[3] - sb[1] - 2 * ctx.params.margin]
      if (room[0] <= 0 || room[1] <= 0) throw problem('fit_to_shape.too_small', { margin: ctx.params.margin })
      const scale = Math.min(room[0] / w, room[1] / d)
      // scale about the middle of the model in x and y, then put that middle on the middle of the shape; the lowest point keeps its height
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tx = (sb[0] + sb[2]) / 2, ty = (sb[1] + sb[3]) / 2
      const out = new Float64Array(p.length)
      for (let i = 0; i < p.length; i += 3) { out[i] = tx + (p[i] - cx) * scale; out[i + 1] = ty + (p[i + 1] - cy) * scale; out[i + 2] = z0 + (p[i + 2] - z0) * scale }
      ctx.progress('fit', 1)
      // keep the labels and bodies the input had (a plugin that changes only positions must carry them through)
      return { mesh: { positions: out, indices: mesh.indices, ...(mesh.segments ? { segments: mesh.segments } : {}), ...(mesh.groups ? { groups: mesh.groups } : {}) }, report: { scale } }
    }
    throw problem('step.unknown_op', { op })
  },
}
