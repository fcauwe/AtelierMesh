// A second test plugin, for steps that change the kind of thing that flows: a square (drawing), a shift (drawing to drawing), an extrusion
// (drawing to mesh), a footprint (mesh to drawing), and one that returns the wrong kind on purpose.
import type { Drawing } from '../drawing'
import { drawingBounds } from '../drawing'
import type { Manifest } from '../manifest'
import type { PluginEntry } from '../registry'
import type { Mesh, PluginModule } from '../types'
import { boxMesh } from './meshes'

export const SHAPES_PLUGIN_ID = 'test.shapes'

export const shapesManifest = (): Manifest => ({
  manifest_version: 1, id: SHAPES_PLUGIN_ID, name: 'Test shapes', version: '1.0.0',
  operations: [
    { id: 'square', title: 'Square', kind: 'generator', payload: { out: 'drawing' }, params: [{ name: 'size', type: 'float', default: 10, min: 1, max: 1000 }] },
    { id: 'shift', title: 'Shift', kind: 'modifier', payload: { in: 'drawing' }, params: [{ name: 'dx', type: 'float', default: 5, min: -1000, max: 1000 }] },
    { id: 'extrude', title: 'Extrude', kind: 'modifier', payload: { in: 'drawing', out: 'mesh' }, params: [{ name: 'height', type: 'float', default: 4, min: 0.1, max: 1000 }] },
    { id: 'footprint', title: 'Footprint', kind: 'modifier', payload: { in: 'mesh', out: 'drawing' }, params: [] },
    { id: 'count', title: 'Count paths', kind: 'analyzer', payload: { in: 'drawing' }, params: [] },
    { id: 'stamp', title: 'Stamp a drawing', kind: 'modifier', params: [{ name: 'shape', type: 'payload', default: null, accept: ['drawing'] }] },
    { id: 'wrong', title: 'Returns a mesh although it promised a drawing', kind: 'modifier', payload: { in: 'drawing' }, params: [] },
  ],
})

const rect = (x0: number, y0: number, x1: number, y1: number): Drawing['paths'][number] => ({ closed: true, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] })

export function createShapesPlugin(): { entry: PluginEntry; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const mod: PluginModule = {
    run(op, ctx) {
      calls[op] = (calls[op] ?? 0) + 1
      const p = ctx.params
      switch (op) {
        case 'square': { const s = p['size'] as number; return { payload: { kind: 'drawing', paths: [rect(0, 0, s, s)] } satisfies Drawing } }
        case 'shift': {
          const d = ctx.payload as Drawing, dx = p['dx'] as number
          return { payload: { ...d, paths: d.paths.map(q => ({ ...q, points: q.points.map(([x, y]) => [x + dx, y] as [number, number]) })) } satisfies Drawing }
        }
        case 'extrude': {
          const b = drawingBounds(ctx.payload as Drawing) ?? [0, 0, 1, 1]
          const m = boxMesh(b[2] - b[0], b[3] - b[1], p['height'] as number)
          const positions = m.positions.slice()
          for (let i = 0; i < positions.length; i += 3) { positions[i] = (positions[i] as number) + (b[0] + b[2]) / 2; positions[i + 1] = (positions[i + 1] as number) + (b[1] + b[3]) / 2 }   // boxMesh is centred on the origin
          return { mesh: { positions, indices: m.indices } }
        }
        case 'footprint': {
          const m = ctx.mesh as Mesh
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (let i = 0; i < m.positions.length; i += 3) { x0 = Math.min(x0, m.positions[i] as number); x1 = Math.max(x1, m.positions[i] as number); y0 = Math.min(y0, m.positions[i + 1] as number); y1 = Math.max(y1, m.positions[i + 1] as number) }
          return { payload: { kind: 'drawing', paths: [rect(x0, y0, x1, y1)] } satisfies Drawing }
        }
        case 'stamp': {
          // a mesh step that takes a stored drawing next to its mesh: the report says what it saw, the mesh is moved by the drawing's width so a change shows
          const d = ctx.payloads['shape'] as Drawing | undefined
          if (!d) throw new Error('no shape')
          const m = ctx.mesh as Mesh, b = drawingBounds(d) ?? [0, 0, 0, 0]
          const positions = m.positions.slice()
          for (let i = 0; i < positions.length; i += 3) positions[i] = (positions[i] as number) + (b[2] - b[0])
          return { mesh: { positions, indices: m.indices }, report: { shapePaths: d.paths.length, shapeWidth: b[2] - b[0] } }
        }
        case 'count': return { report: { paths: (ctx.payload as Drawing).paths.length } }
        case 'wrong': return { mesh: boxMesh(1, 1, 1) }
      }
      throw new Error('unknown op ' + op)
    },
  }
  return { entry: { manifest: shapesManifest(), load: () => mod }, calls }
}
