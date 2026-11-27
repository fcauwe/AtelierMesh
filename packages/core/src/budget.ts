// Budgets and shape checks for meshes that come from outside the engine (files, external plugins).
import { MeshError } from './errors'
import type { Mesh } from './types'

export interface MeshLimits {
  maxTriangles?: number
  maxVertices?: number
}

export function checkMeshBudget(m: Mesh, limits: MeshLimits, of: 'source' | 'result' | 'file' = 'source'): void {
  const nt = m.indices.length / 3, nv = m.positions.length / 3
  if (limits.maxTriangles !== undefined && nt > limits.maxTriangles) throw new MeshError('budget.triangles', { triangles: nt, max: limits.maxTriangles, of })
  if (limits.maxVertices !== undefined && nv > limits.maxVertices) throw new MeshError('budget.vertices', { vertices: nv, max: limits.maxVertices, of })
}

/**
 * Is this a usable mesh? Typed arrays of the right shape, finite positions, indices in range. Returns the first problem or null.
 * Used on every mesh from a file and from a plugin the host does not trust.
 */
export function meshShapeProblem(m: unknown): string | null {
  const x = m as Partial<Mesh> | null
  if (!x || typeof x !== 'object') return 'not an object'
  if (!(x.positions instanceof Float64Array)) return 'positions is not a Float64Array'
  if (!(x.indices instanceof Uint32Array)) return 'indices is not a Uint32Array'
  if (x.positions.length % 3 !== 0) return 'positions length is not a multiple of 3'
  if (x.indices.length % 3 !== 0) return 'indices length is not a multiple of 3'
  const nv = x.positions.length / 3
  for (let i = 0; i < x.positions.length; i++) if (!Number.isFinite(x.positions[i])) return `position ${i} is not finite`
  for (let i = 0; i < x.indices.length; i++) if ((x.indices[i] as number) >= nv) return `index ${i} points past the last vertex`
  if (x.segments && x.segments.labels.length !== x.indices.length / 3) return 'segment labels do not match the triangle count'
  return null
}

/** An operation's own limits (manifest `limits`). `of` says which side of the step is being checked. */
export function checkOperationLimits(m: Mesh, limits: { max_input_triangles?: number; max_output_triangles?: number; max_memory_mb?: number } | undefined, of: 'input' | 'result', op: string): void {
  if (!limits) return
  const nt = m.indices.length / 3
  const max = of === 'input' ? limits.max_input_triangles : limits.max_output_triangles
  if (max !== undefined && nt > max) throw new MeshError('budget.triangles', { triangles: nt, max, of, op })
  if (limits.max_memory_mb !== undefined) {
    const mb = (m.positions.byteLength + m.indices.byteLength) / 1048576
    if (mb > limits.max_memory_mb) throw new MeshError('budget.memory', { mb: Math.ceil(mb), max: limits.max_memory_mb, of, op })
  }
}
