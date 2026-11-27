// Mirror, as plain JavaScript: ONE file, no imports, no build, no npm. The same plugin as ../mirror-full (which is TypeScript with tests).
// A plugin is one ES module whose default export has a run(op, ctx) function.
//   ctx.mesh    { positions: Float64Array (x, y, z per vertex), indices: Uint32Array (3 per triangle), segments?, groups? } in millimetres, Z up. Never change it: build a new one.
//   ctx.params  the settings, already checked against the manifest, defaults filled in
//   ctx.signal  look at ctx.signal.aborted every few thousand steps and stop with run.cancelled
//   ctx.progress(stage, fraction)  tell the host how far you are
// An expected problem is thrown as a plain object { code, params } (NOT an Error). Return { mesh, report }.

const problem = (code, params = {}) => ({ code, params })
const AXIS = { x: 0, y: 1, z: 2 }

export default {
  async run(op, ctx) {
    if (op !== 'mirror') throw problem('step.unknown_op', { op })
    const mesh = ctx.mesh
    if (!mesh) throw problem('input.missing_mesh', { op })
    const p = ctx.params
    const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
    if (nt === 0) throw problem('mirror.empty')
    ctx.progress('mirror', 0)
    const a = AXIS[p.axis]
    let lo = Infinity, hi = -Infinity
    for (let i = a; i < mesh.positions.length; i += 3) { const v = mesh.positions[i]; if (v < lo) lo = v; if (v > hi) hi = v }
    if (ctx.signal.aborted) throw problem('run.cancelled')

    // flip: mirror in place (the bounding box stays where it is). copy: add a mirrored copy `gap` mm beyond the far end.
    const copy = p.mode === 'copy'
    const plane = copy ? 2 * hi + p.gap : lo + hi
    const copies = copy ? 2 : 1
    const base = copy ? 1 : 0                                     // the mirrored triangles start at this copy
    const positions = new Float64Array(mesh.positions.length * copies)
    const indices = new Uint32Array(mesh.indices.length * copies)
    if (copy) { positions.set(mesh.positions); indices.set(mesh.indices) }
    const po = base * mesh.positions.length, io = base * mesh.indices.length
    for (let i = 0; i < mesh.positions.length; i++) positions[po + i] = i % 3 === a ? plane - mesh.positions[i] : mesh.positions[i]
    // a mirror image turns every triangle inside out: swap two corners so it faces outwards again (counter-clockwise seen from outside)
    for (let t = 0; t < nt; t++) {
      indices[io + 3 * t] = mesh.indices[3 * t] + base * nv
      indices[io + 3 * t + 1] = mesh.indices[3 * t + 2] + base * nv
      indices[io + 3 * t + 2] = mesh.indices[3 * t + 1] + base * nv
    }
    const out = { positions, indices }

    // carry the labels through: segments follow their triangles, groups (bodies) follow their ranges
    if (mesh.segments) {
      const labels = new Uint16Array(nt * copies)
      if (copy) labels.set(mesh.segments.labels)
      labels.set(mesh.segments.labels, base * nt)
      out.segments = { labels, table: mesh.segments.table.map(s => ({ ...s })) }
    }
    if (copy) {
      const own = mesh.groups ?? [{ start: 0, count: nt, role: 'solid', name: 'original' }]
      out.groups = [...own.map(g => ({ ...g })), ...own.map((g, i) => ({ start: g.start + nt, count: g.count, role: g.role, name: `${g.name ?? `part_${i + 1}`}_mirror`, ...(g.color ? { color: g.color } : {}) }))]   // colour lives on parts: the copy keeps it
    } else if (mesh.groups) out.groups = mesh.groups.map(g => ({ ...g }))

    ctx.progress('mirror', 1)
    return { mesh: out, report: { axis: p.axis, plane: copy ? hi + p.gap / 2 : (lo + hi) / 2, triangles: nt * copies } }
  },
}
