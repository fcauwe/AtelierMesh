// Shared by the colour tests: a part that carries colours, a way to run one operation, and the check that the colours came out.
import { expect } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, runWorkflow } from '@ateliermesh/core'
import type { Mesh, PluginEntry } from '@ateliermesh/core'
import { gridBox } from '../src/samples'

export const BODY_A = '#e5484d', BODY_B = '#30a46c', SEG = '#ffd400'

/** Two bodies side by side, `Lid` and `Base`, each with a body colour, and a segment `mark` (coloured) on the first triangles of Base. */
export function colouredParts(): Mesh {
  const a = gridBox(20, 20, 10, 4, 4, 2), b = gridBox(20, 20, 10, 4, 4, 2)
  const na = a.indices.length / 3, nb = b.indices.length / 3, nv = a.positions.length / 3
  const pos = new Float64Array(a.positions.length + b.positions.length)
  pos.set(a.positions); b.positions.forEach((v, i) => { pos[a.positions.length + i] = i % 3 === 0 ? v + 40 : v })
  const labels = new Uint16Array(na + nb); for (let i = na; i < na + 12; i++) labels[i] = 1
  return {
    positions: pos, indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, v => v + nv)]),
    groups: [{ start: 0, count: na, role: 'solid', name: 'Lid', color: BODY_A }, { start: na, count: nb, role: 'solid', name: 'Base', color: BODY_B }],
    segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'mark', color: SEG }] },
  }
}

/** Run one operation of a plugin on `mesh` and return the result mesh. */
export async function runOp(plugin: PluginEntry, op: string, params: Record<string, unknown>, mesh: Mesh): Promise<Mesh> {
  const m = plugin.manifest
  const res = await runWorkflow(addStep(emptyStepList(), makeStep({ id: 's', plugin: { id: m.id, version: m.version }, op, params })), { registry: new Registry().register(plugin), source: mesh, quality: 'export' })
  const r = res.results[0]!
  if (r.status !== 'ok') throw new Error(`${m.id} ${op}: ${JSON.stringify((r as { error?: unknown }).error)}`)
  return res.mesh as Mesh
}

/** The colours of the input are still on the parts of the output (the bodies that are still there, and the segment). */
export function expectColoursKept(out: Mesh, opts: { bodies?: string[]; segment?: boolean } = {}): void {
  const want: Record<string, string> = { Lid: BODY_A, Base: BODY_B }
  const bodies = opts.bodies ?? ['Lid', 'Base']
  for (const name of bodies) expect(out.groups?.find(g => g.name === name)?.color, `body ${name}`).toBe(want[name])
  if (opts.segment !== false) expect(out.segments?.table.find(s => s.name === 'mark')?.color, 'segment mark').toBe(SEG)
}
