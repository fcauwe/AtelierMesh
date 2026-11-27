// The WebAssembly decimator: the same algorithm as decimate.ts, compiled from Rust (wasm/decimate). Same inputs, same result shape.
import { MeshError } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { decimate, decimateBodies } from './decimate'
import type { DecimateOptions, DecimateResult } from './decimate'
import { DECIMATE_WASM_BASE64 } from './decimate.wasm.generated'

interface Exports {
  memory: WebAssembly.Memory
  alloc(n: number): number
  dealloc(p: number, n: number): void
  decimate(pos: number, nv: number, idx: number, nt: number, labels: number, target: number, maxErr2: number, keepBoundary: number, keepCreases: number, creaseCos: number): number
  out_nv(): number
  out_nt(): number
  out_pos(): number
  out_idx(): number
  out_labels(): number
  out_collapses(): number
  out_max_cost(): number
}

let instance: Promise<Exports> | null = null

export const wasmAvailable = (): boolean => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'

function load(): Promise<Exports> {
  instance ??= (async () => {
    const bin = Uint8Array.from(atob(DECIMATE_WASM_BASE64), c => c.charCodeAt(0))
    const { instance: i } = await WebAssembly.instantiate(bin, {})
    return i.exports as unknown as Exports
  })()
  return instance
}

/** Decimate in WebAssembly. Not cancellable while it runs (it is synchronous inside the call); a worker can be terminated instead. */
export async function decimateWasm(mesh: Mesh, opts: DecimateOptions): Promise<DecimateResult> {
  if (mesh.groups && mesh.groups.length > 0) return decimateBodies(mesh, opts, (m, o) => decimateWasm({ ...m }, o))
  if (opts.signal?.aborted) throw new MeshError('run.cancelled')
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  const target = Math.max(4, Math.floor(opts.targetTriangles))
  if (nt <= target) return { mesh, before: nt, after: nt, maxError: 0, collapses: 0 }
  const w = await load()
  const sizes = [nv * 24, nt * 12, mesh.segments ? nt * 2 : 0]
  const ptrs = sizes.map(n => (n > 0 ? w.alloc(n) : 0))
  try {
    // alloc may grow the memory: take the views after all allocations
    new Float64Array(w.memory.buffer, ptrs[0] as number, nv * 3).set(mesh.positions)
    new Uint32Array(w.memory.buffer, ptrs[1] as number, nt * 3).set(mesh.indices)
    if (mesh.segments) new Uint16Array(w.memory.buffer, ptrs[2] as number, nt).set(mesh.segments.labels)
    const maxErr2 = opts.maxError && opts.maxError > 0 ? opts.maxError * opts.maxError : Infinity
    const code = w.decimate(ptrs[0] as number, nv, ptrs[1] as number, nt, ptrs[2] as number, target, maxErr2, opts.preserveBoundary === false ? 0 : 1, opts.preserveCreases === false ? 0 : 1, Math.cos(((opts.creaseAngle ?? 40) * Math.PI) / 180))
    if (code === 2) throw new MeshError('decimate.bad_input')
    if (code === 1) return { mesh, before: nt, after: nt, maxError: 0, collapses: 0 }
    const onv = w.out_nv(), ont = w.out_nt()
    const out: Mesh = {
      positions: new Float64Array(w.memory.buffer, w.out_pos(), onv * 3).slice(),
      indices: new Uint32Array(w.memory.buffer, w.out_idx(), ont * 3).slice(),
    }
    if (mesh.segments) out.segments = { labels: new Uint16Array(w.memory.buffer, w.out_labels(), ont).slice(), table: mesh.segments.table.map(s => ({ ...s })) }
    opts.onProgress?.(1)
    return { mesh: out, before: nt, after: ont, maxError: Math.sqrt(w.out_max_cost()), collapses: w.out_collapses() }
  } finally {
    sizes.forEach((n, i) => { if (n > 0) w.dealloc(ptrs[i] as number, n) })
  }
}

/**
 * Decimate with the engine the caller asks for: `auto` is WebAssembly where it exists and JavaScript otherwise. A WebAssembly failure that is not
 * "this mesh cannot be used" falls back to JavaScript, which is the same algorithm. Used by the `decimate` and `low_poly` operations.
 */
export async function decimateAuto(mesh: Mesh, opts: DecimateOptions, engine: 'auto' | 'wasm' | 'js' = 'auto'): Promise<DecimateResult & { engine: 'wasm' | 'js' }> {
  if (engine === 'wasm' || (engine === 'auto' && wasmAvailable())) {
    try { return { ...(await decimateWasm(mesh, opts)), engine: 'wasm' } } catch (e) { if (engine === 'wasm' || (e instanceof MeshError && e.code !== 'decimate.bad_input')) throw e }
  }
  const r = mesh.groups && mesh.groups.length > 0 ? await decimateBodies(mesh, opts, (m, o) => decimate(m, o)) : decimate(mesh, opts)
  return { ...r, engine: 'js' }
}
