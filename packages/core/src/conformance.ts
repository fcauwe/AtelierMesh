// Conformance fixtures: a small, host-independent way to check that a plugin still computes the same thing.
// A fixture has an input mesh, steps and expected measurements WITH TOLERANCES. Results are compared by volume, size and
// counts, never by bytes, so floating-point differences between engines and machines do not matter.
// The Atelier's CI runs the fixtures of every plugin it vendors.
import { MeshError } from './errors'
import type { FontService, PluginHost } from './host'
import { measureMesh } from './measure'
import type { Registry } from './registry'
import { runWorkflow } from './runner'
import type { Step } from './stack'
import { boxMesh, cylinderMesh, lBracketMesh, sphereMesh } from './testing/meshes'
import type { Drawing } from './drawing'
import { drawingBounds, drawingPointCount } from './drawing'
import { isMesh, payloadKindOf } from './payload'
import type { AssetResolver, Mesh, Payload, Vec3 } from './types'

export interface Approx { value: number; tol: number }
export interface Range { min?: number; max?: number }

export type FixtureInput =
  | null
  | { kind: 'generator'; name: 'box' | 'cylinder' | 'sphere' | 'l_bracket'; params?: Record<string, number> }
  | { kind: 'mesh'; positions: number[]; indices: number[] }
  /** A flat drawing as the starting point (a step that takes a drawing). */
  | Drawing

export interface FixtureExpect {
  /** Default true. */
  ok?: boolean
  /** When `ok` is false: the code of the first failing step's error. */
  error_code?: string
  triangles?: number | Range
  vertices?: number | Range
  volume?: Approx
  surface_area?: Approx
  size?: { value: Vec3; tol: number }
  bbox?: { min: Vec3; max: Vec3; tol: number }
  watertight?: boolean
  /** What the result is when it is not a mesh (a drawing), or what kind it is. */
  payload?: { kind?: string; paths?: number | Range; points?: number | Range; bounds?: { value: [number, number, number, number]; tol: number } }
  /** Values in the report of a given step (index in the step list). */
  step_reports?: Array<{ step: number; key: string; expect: number | string | boolean | Approx }>
}

export interface Fixture {
  name: string
  description?: string
  input: FixtureInput
  /** Items in the project store, by name, for steps with `payload` parameters: a drawing, or a mesh. */
  store?: Record<string, Payload>
  steps: Step[]
  expect: FixtureExpect
}

export interface FixtureResult {
  name: string
  ok: boolean
  failures: string[]
}

/** What a fixture starts from: a mesh, or a drawing. */
export function buildFixtureSource(input: FixtureInput): Payload | undefined {
  if (input !== null && input.kind === 'drawing') return input
  return buildFixtureMesh(input)
}

export function buildFixtureMesh(input: FixtureInput): Mesh | undefined {
  if (input === null || input.kind === 'drawing') return undefined
  if (input.kind === 'mesh') return { positions: Float64Array.from(input.positions), indices: Uint32Array.from(input.indices) }
  const p = input.params ?? {}
  switch (input.name) {
    case 'box': return boxMesh(p['width'] ?? 10, p['depth'] ?? 10, p['height'] ?? 10)
    case 'cylinder': return cylinderMesh(p['radius'] ?? 5, p['height'] ?? 10, p['segments'] ?? 48)
    case 'sphere': return sphereMesh(p['radius'] ?? 5, p['subdivisions'] ?? 3)
    case 'l_bracket': return lBracketMesh()
  }
}

const isApprox = (v: unknown): v is Approx => typeof v === 'object' && v !== null && 'value' in v && 'tol' in v

function range(label: string, actual: number, want: number | Range, out: string[]): void {
  if (typeof want === 'number') { if (actual !== want) out.push(`${label}: expected ${want}, got ${actual}`); return }
  if (want.min !== undefined && actual < want.min) out.push(`${label}: ${actual} is below ${want.min}`)
  if (want.max !== undefined && actual > want.max) out.push(`${label}: ${actual} is above ${want.max}`)
}

function approx(label: string, actual: number, want: Approx, out: string[]): void {
  if (!(Math.abs(actual - want.value) <= want.tol)) out.push(`${label}: expected ${want.value} ± ${want.tol}, got ${actual}`)
}

export async function runFixture(f: Fixture, opts: { registry: Registry; host?: PluginHost; fonts?: FontService; assets?: AssetResolver }): Promise<FixtureResult> {
  const failures: string[] = []
  const wantOk = f.expect.ok !== false
  let res
  try {
    res = await runWorkflow({ schema_version: 1, steps: f.steps }, { registry: opts.registry, host: opts.host, source: buildFixtureSource(f.input), ...(f.store ? { store: Object.fromEntries(Object.entries(f.store).map(([k, v]) => [k, { payload: v }])) } : {}), ...(opts.fonts ? { fonts: opts.fonts } : {}), ...(opts.assets ? { assets: opts.assets } : {}) })
  } catch (e) {
    if (!wantOk && e instanceof MeshError && (f.expect.error_code === undefined || e.code === f.expect.error_code)) return { name: f.name, ok: true, failures }
    return { name: f.name, ok: false, failures: [`threw ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (!wantOk) {
    if (res.ok) failures.push('expected the workflow to fail, but it succeeded')
    else if (f.expect.error_code !== undefined) {
      const code = res.results[res.firstProblem]?.error?.code
      if (code !== f.expect.error_code) failures.push(`expected error ${f.expect.error_code}, got ${code ?? 'none'}`)
    }
    return { name: f.name, ok: failures.length === 0, failures }
  }
  if (!res.ok) {
    const e = res.results[res.firstProblem]?.error
    return { name: f.name, ok: false, failures: [`workflow failed at step ${res.firstProblem}: ${e?.code ?? 'unknown'} ${JSON.stringify(e?.params ?? {})}`] }
  }
  const x = f.expect
  if (res.mesh) {
    const m = measureMesh(res.mesh)
    if (x.triangles !== undefined) range('triangles', m.triangles, x.triangles, failures)
    if (x.vertices !== undefined) range('vertices', m.vertices, x.vertices, failures)
    if (x.volume) approx('volume', m.volume, x.volume, failures)
    if (x.surface_area) approx('surface_area', m.surfaceArea, x.surface_area, failures)
    if (x.size) x.size.value.forEach((v, i) => approx(`size[${i}]`, m.size[i] as number, { value: v, tol: x.size?.tol ?? 0 }, failures))
    if (x.bbox) for (let i = 0; i < 3; i++) {
      approx(`bbox.min[${i}]`, m.bbox.min[i] as number, { value: x.bbox.min[i] as number, tol: x.bbox.tol }, failures)
      approx(`bbox.max[${i}]`, m.bbox.max[i] as number, { value: x.bbox.max[i] as number, tol: x.bbox.tol }, failures)
    }
    if (x.watertight !== undefined && m.watertight !== x.watertight) failures.push(`watertight: expected ${x.watertight}, got ${m.watertight}`)
  } else if (x.triangles !== undefined || x.volume || x.size || x.bbox || x.watertight !== undefined) failures.push('the workflow produced no mesh')
  if (x.payload) {
    const out = res.payload
    if (!out) failures.push('the workflow produced no result')
    else {
      const kind = payloadKindOf(out)
      if (x.payload.kind !== undefined && kind !== x.payload.kind) failures.push(`result kind: expected ${x.payload.kind}, got ${kind}`)
      if (!isMesh(out) && kind === 'drawing') {
        const d = out as Drawing
        if (x.payload.paths !== undefined) range('paths', d.paths.length, x.payload.paths, failures)
        if (x.payload.points !== undefined) range('points', drawingPointCount(d), x.payload.points, failures)
        if (x.payload.bounds) {
          const b = drawingBounds(d)
          if (!b) failures.push('bounds: the drawing is empty')
          else x.payload.bounds.value.forEach((v, i) => approx(`bounds[${i}]`, b[i] as number, { value: v, tol: x.payload?.bounds?.tol ?? 0 }, failures))
        }
      } else if ((x.payload.paths !== undefined || x.payload.points !== undefined || x.payload.bounds) && kind !== 'drawing') failures.push(`the result is a ${kind}, not a drawing`)
    }
  }
  for (const r of x.step_reports ?? []) {
    const got = res.results[r.step]?.report?.[r.key]
    if (got === undefined) { failures.push(`step ${r.step} report has no "${r.key}"`); continue }
    if (isApprox(r.expect)) { if (typeof got !== 'number') failures.push(`step ${r.step} report "${r.key}" is not a number`); else approx(`step ${r.step} report "${r.key}"`, got, r.expect, failures) }
    else if (got !== r.expect) failures.push(`step ${r.step} report "${r.key}": expected ${String(r.expect)}, got ${String(got)}`)
  }
  return { name: f.name, ok: failures.length === 0, failures }
}

export async function runFixtures(fixtures: Fixture[], opts: { registry: Registry; host?: PluginHost; fonts?: FontService; assets?: AssetResolver }): Promise<FixtureResult[]> {
  const out: FixtureResult[] = []
  for (const f of fixtures) out.push(await runFixture(f, opts))
  return out
}
