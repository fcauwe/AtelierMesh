// A small plugin for tests: operations that scale, generate, measure, fail, run slowly or ignore cancellation.
// It exists so the engine can be tested without any real plugin.
import { MeshError } from '../errors'
import type { Manifest } from '../manifest'
import { measureMesh } from '../measure'
import type { PluginEntry } from '../registry'
import type { Mesh, PluginModule, RunContext } from '../types'
import { assignSegment, borderVertices, selectTriangles } from '../segments'
import { boxMesh } from './meshes'

export const TEST_PLUGIN_ID = 'test.core'

export const testManifest = (version = '1.0.0'): Manifest => ({
  manifest_version: 1,
  id: TEST_PLUGIN_ID,
  name: 'Test plugin',
  version,
  operations: [
    {
      id: 'scale', title: 'Scale', kind: 'modifier', personalisable: 'optional',
      params: [
        { name: 'factor', type: 'float', default: 1, min: 0.1, max: 10, unit: '%', personalisable: true },
        { name: 'mode', type: 'enum', default: 'uniform', options: ['uniform', 'xy'] },
        { name: 'label', type: 'string', default: '', max_length: 12, personalisable: true },
      ],
    },
    { id: 'box', title: 'Box', kind: 'generator', params: [
      { name: 'width', type: 'float', default: 10, min: 1, max: 1000 },
      { name: 'depth', type: 'float', default: 10, min: 1, max: 1000 },
      { name: 'height', type: 'float', default: 10, min: 1, max: 1000 },
    ] },
    { id: 'measure', title: 'Measure', kind: 'analyzer', params: [] },
    { id: 'font_outline', title: 'Ask the host for letter outlines', kind: 'analyzer', params: [{ name: 'font', type: 'string', default: 'font', max_length: 64 }, { name: 'text', type: 'string', default: 'Hi', max_length: 64 }, { name: 'size', type: 'float', default: 10, min: 0, max: 5000 }] },
    { id: 'read_asset', title: 'Read an asset from the host', kind: 'analyzer', params: [{ name: 'id', type: 'string', default: 'font', max_length: 64 }] },
    { id: 'label_top', title: 'Label the upward-facing triangles', kind: 'modifier', params: [{ name: 'name', type: 'string', default: 'top', max_length: 40, pattern: '^[a-z][a-z0-9_]*$' }] },
    { id: 'lift', title: 'Move the vertices of one segment up', kind: 'modifier', params: [
      { name: 'segment', type: 'part', kinds: ['segment'], default: '' },
      { name: 'dz', type: 'float', default: 1, min: -100, max: 100 },
    ] },
    { id: 'fail', title: 'Fail on purpose', kind: 'modifier', params: [] },
    { id: 'nomesh', title: 'Returns no mesh', kind: 'modifier', params: [] },
    { id: 'crash', title: 'Crash with a ReferenceError', kind: 'modifier', params: [] },
    { id: 'die', title: 'Take the worker down', kind: 'modifier', params: [] },
    { id: 'slow', title: 'Slow', kind: 'modifier', params: [{ name: 'ms', type: 'int', default: 200, min: 0, max: 60000 }] },
    { id: 'stubborn', title: 'Ignores cancellation', kind: 'modifier', params: [{ name: 'ms', type: 'int', default: 5000, min: 0, max: 60000 }] },
    { id: 'big', title: 'Makes a large mesh', kind: 'generator', params: [{ name: 'triangles', type: 'int', default: 1000, min: 1, max: 10000000 }] },
  ],
})

export interface TestPlugin {
  entry: PluginEntry
  /** How many times each operation ran in this thread. */
  calls: Record<string, number>
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export function createTestPlugin(version = '1.0.0', module: Partial<PluginModule> = {}): TestPlugin {
  const calls: Record<string, number> = {}
  const mod: PluginModule = {
    async run(op: string, ctx: RunContext) {
      calls[op] = (calls[op] ?? 0) + 1
      const p = ctx.params
      switch (op) {
        case 'scale': {
          const m = ctx.mesh as Mesh, f = p['factor'] as number, xyOnly = p['mode'] === 'xy'
          const positions = new Float64Array(m.positions.length)
          for (let i = 0; i < positions.length; i += 3) { positions[i] = (m.positions[i] as number) * f; positions[i + 1] = (m.positions[i + 1] as number) * f; positions[i + 2] = (m.positions[i + 2] as number) * (xyOnly ? 1 : f) }
          ctx.progress('scale', 1)
          return { mesh: { positions, indices: m.indices }, report: { factor: f } }
        }
        case 'box': return { mesh: boxMesh(p['width'] as number, p['depth'] as number, p['height'] as number) }
        case 'measure': { const m = measureMesh(ctx.mesh as Mesh); return { report: { triangles: m.triangles, volume: m.volume, watertight: m.watertight } } }
        case 'font_outline': { const o = await ctx.fonts.outline(p['font'] as string, p['text'] as string, { size: p['size'] as number }); return { report: { contours: o.contours.length, bbox: o.bbox, fillRule: o.fillRule, size: o.size } } }
        case 'read_asset': { const bytes = await ctx.assets(p['id'] as string); return { report: { length: bytes.length, first: bytes[0] ?? -1 } } }
        case 'label_top': {
          const m = ctx.mesh as Mesh, P = m.positions, T = m.indices
          const flags = new Uint8Array(T.length / 3)
          for (let i = 0; i < flags.length; i++) {
            const a = 3 * (T[3 * i] as number), b = 3 * (T[3 * i + 1] as number), c = 3 * (T[3 * i + 2] as number)
            const ux = (P[b] as number) - (P[a] as number), uy = (P[b + 1] as number) - (P[a + 1] as number)
            const vx = (P[c] as number) - (P[a] as number), vy = (P[c + 1] as number) - (P[a + 1] as number)
            flags[i] = ux * vy - uy * vx > 1e-9 && (P[a + 2] as number) === (P[b + 2] as number) && (P[b + 2] as number) === (P[c + 2] as number) && (P[a + 2] as number) > 0 ? 1 : 0
          }
          return { mesh: assignSegment(m, p['name'] as string, flags) }
        }
        case 'lift': {
          const m = ctx.mesh as Mesh, sel = selectTriangles(m, p['segment'] as string)
          const positions = m.positions.slice()
          const border = sel ? borderVertices(m, sel) : null
          const inside = new Uint8Array(positions.length / 3)
          for (let t = 0; t < m.indices.length / 3; t++) if (!sel || sel[t]) for (let k = 0; k < 3; k++) inside[m.indices[3 * t + k] as number] = 1
          let moved = 0
          for (let v = 0; v < inside.length; v++) if (inside[v] && !(border && border[v])) { positions[3 * v + 2] = (positions[3 * v + 2] as number) + (p['dz'] as number); moved++ }
          return { mesh: { ...m, positions }, report: { moved } }
        }
        case 'fail': throw new MeshError('test.deliberate', { why: 'asked to' })
        case 'nomesh': return {}
        // a plugin bug: a name that does not exist (the text is what a browser says)
        case 'crash': return { mesh: (globalThis as unknown as { notDefinedAnywhere: Mesh }).notDefinedAnywhere ?? (() => { throw new ReferenceError('voronoiPlugin is not defined') })() }
        // an uncaught error outside any promise: in a worker this kills the thread; in this thread it is thrown into the run
        case 'die': throw new TypeError('Cannot read properties of undefined (reading \'x\')\n    at fake (plugin.js:1:1)')
        case 'slow': {
          const until = Date.now() + (p['ms'] as number)
          while (Date.now() < until) {
            if (ctx.signal.aborted) throw ctx.signal.reason instanceof MeshError ? ctx.signal.reason : new MeshError('run.cancelled')
            ctx.progress('waiting', 1 - (until - Date.now()) / (p['ms'] as number))
            await sleep(5)
          }
          return { mesh: ctx.mesh }
        }
        case 'stubborn': await sleep(p['ms'] as number); return { mesh: ctx.mesh } // never looks at the signal
        case 'big': {
          const n = p['triangles'] as number
          return { mesh: { positions: new Float64Array(9 * n), indices: Uint32Array.from({ length: 3 * n }, (_, i) => i) } }
        }
        default: throw new MeshError('step.unknown_op', { op })
      }
    },
    ...module,
  }
  return { entry: { manifest: testManifest(version), load: () => mod }, calls }
}
