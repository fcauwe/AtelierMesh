// What flows from one step to the next. A payload is a mesh (the default, no tag) or any other kind that carries a `kind` word (`drawing` is built in).
// Every kind says how to recognise itself, fingerprint itself for the cache, count its memory, check itself when it comes from outside, and
// save and load itself in a project. An operation names the kind it takes and the kind it returns (`operation.payload`), so a workflow can
// start from a drawing and extrude it into a mesh. Meshes behave exactly as before.
import { MeshError } from './errors'
import { checkMeshBudget, meshShapeProblem } from './budget'
import type { MeshLimits } from './budget'
import { checkDrawingBudget, decodeDrawing, drawingBytes, drawingKey, drawingShapeProblem, encodeDrawing, isDrawing } from './drawing'
import type { DrawingLimits } from './drawing'
import { meshKey } from './meshkey'
import type { Operation } from './manifest'
import { decodeMesh, encodeMesh } from './project'
import type { StoreLimits } from './store'
import type { Mesh, Payload } from './types'

/** The word that names a kind: `mesh`, `drawing`, or one a host registers. */
export type PayloadKindId = string
export const PAYLOAD_KIND_RE = /^[a-z][a-z0-9_]{0,39}$/

export interface PayloadLimits extends MeshLimits, DrawingLimits, StoreLimits {}

export interface PayloadKind<P = Payload> {
  id: PayloadKindId
  /** Does this value belong to this kind? Structural and cheap. */
  is(x: unknown): x is P
  /** A fingerprint of the content, for the cache key of the first step. */
  key(p: P): string
  /** Memory the value takes, for the cache budget. */
  bytes(p: P): number
  /** What is wrong with a value that comes from outside (a file, a plugin the host does not trust); null when it is usable. */
  problem(x: unknown): string | null
  /** Refuse a value over the host's budget (throws a `MeshError`). */
  budget(p: P, limits: PayloadLimits, of: 'source' | 'result' | 'file'): void
  /** File extension inside a project (`inputs/base.<extension>`). */
  extension: string
  encode(p: P): Uint8Array
  decode(bytes: Uint8Array, limits: PayloadLimits): P
}

export class PayloadKinds {
  private readonly kinds = new Map<PayloadKindId, PayloadKind<never>>()

  register<P>(kind: PayloadKind<P>): this {
    if (!PAYLOAD_KIND_RE.test(kind.id)) throw new MeshError('payload.bad_kind', { id: kind.id })
    if (this.kinds.has(kind.id)) throw new MeshError('payload.bad_kind', { id: kind.id, reason: 'duplicate' })
    this.kinds.set(kind.id, kind as unknown as PayloadKind<never>)
    return this
  }

  has(id: PayloadKindId): boolean { return this.kinds.has(id) }
  ids(): PayloadKindId[] { return [...this.kinds.keys()] }
  get(id: PayloadKindId): PayloadKind { const k = this.kinds.get(id); if (!k) throw new MeshError('payload.unknown_kind', { kind: id }); return k as unknown as PayloadKind }

  /** The kind of a value: its `kind` word, or `mesh` when it has none. */
  kindOf(p: Payload): PayloadKindId { return payloadKindOf(p) }
  key(p: Payload): string { return this.get(this.kindOf(p)).key(p) }
  bytes(p: Payload | undefined): number { return p ? this.get(this.kindOf(p)).bytes(p) : 0 }
  problem(p: unknown): string | null {
    const id = typeof p === 'object' && p !== null ? payloadKindOf(p as Payload) : ''
    return this.kinds.has(id) ? (this.kinds.get(id) as unknown as PayloadKind).problem(p) : 'unknown kind'
  }
  budget(p: Payload, limits: PayloadLimits, of: 'source' | 'result' | 'file'): void { this.get(this.kindOf(p)).budget(p, limits, of) }
}

export const isMesh = (x: unknown): x is Mesh => typeof x === 'object' && x !== null && (x as Mesh).positions instanceof Float64Array && (x as Mesh).indices instanceof Uint32Array

/** `kind` word of a payload; a value without one is a mesh. */
export function payloadKindOf(p: Payload | unknown): PayloadKindId {
  const k = typeof p === 'object' && p !== null ? (p as { kind?: unknown }).kind : undefined
  return typeof k === 'string' ? k : 'mesh'
}

const meshKind: PayloadKind<Mesh> = {
  id: 'mesh',
  is: isMesh,
  key: meshKey,
  bytes: m => m.positions.byteLength + m.indices.byteLength + (m.segments ? m.segments.labels.byteLength : 0),
  problem: meshShapeProblem,
  budget: (m, l, of) => checkMeshBudget(m, l, of),
  extension: 'ammesh',
  encode: encodeMesh,
  decode: (b, l) => decodeMesh(b, l),
}

const drawingKind: PayloadKind<import('./drawing').Drawing> = {
  id: 'drawing',
  is: isDrawing,
  key: drawingKey,
  bytes: drawingBytes,
  problem: drawingShapeProblem,
  budget: (d, l, of) => checkDrawingBudget(d, l, of),
  extension: 'amdraw',
  encode: encodeDrawing,
  decode: (b, l) => decodeDrawing(b, l),
}

/** The kinds every host knows: `mesh` and `drawing`. A host that adds a kind registers it here, in the page and in the worker. */
export const payloadKinds: PayloadKinds = new PayloadKinds().register(meshKind).register(drawingKind)

/** What an operation takes and returns. Default: a mesh in, the same kind out. A generator ignores `in`. */
export function operationPayload(op: Pick<Operation, 'payload'>): { in: PayloadKindId; out: PayloadKindId } {
  const i = op.payload?.in ?? 'mesh'
  return { in: i, out: op.payload?.out ?? i }   // `*` stays `*`: the store operations pass any kind through
}
