// Result cache: what a step computed, keyed on plugin, version, canonical parameters and the chain of inputs.
import type { StructuredError } from './errors'
import { payloadKinds } from './payload'
import type { Mesh, Payload } from './types'

export interface CachedStep {
  mesh?: Mesh
  /** The result when it is not a mesh. */
  payload?: Payload
  report?: Record<string, unknown>
  warnings?: StructuredError[]
}

export interface ResultCache {
  get(key: string): CachedStep | undefined
  set(key: string, value: CachedStep): void
  delete(key: string): void
  clear(): void
}

export function meshBytes(m: Mesh | undefined): number {
  return m ? m.positions.byteLength + m.indices.byteLength : 0
}

/** Least-recently-used cache with a byte budget. The entry just stored is never evicted by its own insertion. */
export class MemoryCache implements ResultCache {
  private readonly map = new Map<string, { value: CachedStep; bytes: number }>()
  private total = 0
  readonly maxBytes: number
  readonly maxEntries: number

  constructor(opts: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? 512 * 1024 * 1024
    this.maxEntries = opts.maxEntries ?? 64
  }

  get size(): number { return this.map.size }
  get bytes(): number { return this.total }

  get(key: string): CachedStep | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    this.map.delete(key); this.map.set(key, e) // most recently used goes last
    return e.value
  }

  set(key: string, value: CachedStep): void {
    this.delete(key)
    const bytes = meshBytes(value.mesh) + (value.payload && value.payload !== value.mesh ? payloadKinds.bytes(value.payload) : 0)
    this.map.set(key, { value, bytes }); this.total += bytes
    for (const k of this.map.keys()) {
      if (this.map.size <= 1 || (this.total <= this.maxBytes && this.map.size <= this.maxEntries)) break
      if (k === key) continue
      this.delete(k)
    }
  }

  delete(key: string): void {
    const e = this.map.get(key)
    if (e) { this.total -= e.bytes; this.map.delete(key) }
  }

  clear(): void { this.map.clear(); this.total = 0 }
}
