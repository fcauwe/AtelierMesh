// A fast key for a mesh, used once for the source mesh of a workflow. Later steps chain their keys from it,
// so a large mesh is never hashed twice. 64 bits plus the counts: collisions would need adversarial input,
// and the key only decides whether a cached result can be reused.
import type { Mesh } from './types'

function lane(words: Uint32Array, seed: number, c1: number, c2: number): number {
  let h = seed | 0
  for (let i = 0; i < words.length; i++) {
    let k = Math.imul(words[i] as number, c1)
    k = (k << 15) | (k >>> 17)
    k = Math.imul(k, c2)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  h ^= words.length
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}

const hex8 = (n: number): string => n.toString(16).padStart(8, '0')

/** Segment labels and names also decide what an operation does, so they are part of the key. */
function segmentsPart(mesh: Mesh): string {
  if (!mesh.segments) return ''
  const l = mesh.segments.labels
  const padded = new Uint8Array((l.byteLength + 3) & ~3)
  padded.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength))
  const words = new Uint32Array(padded.buffer)
  const names = JSON.stringify(mesh.segments.table.map(t => [t.id, t.name]))
  let h = 0
  for (let i = 0; i < names.length; i++) h = (Math.imul(h, 31) + names.charCodeAt(i)) | 0
  return `-s${hex8(lane(words, 0x51ed270b, 0xcc9e2d51, 0x1b873593))}${hex8(h >>> 0)}`
}

export function meshKey(mesh: Mesh): string {
  const pos = new Uint32Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength >> 2)
  const idx = mesh.indices
  const a = lane(pos, 0x9747b28c, 0xcc9e2d51, 0x1b873593) ^ lane(idx, 0x12345678, 0xcc9e2d51, 0x1b873593)
  const b = lane(pos, 0x7f4a7c15, 0x85ebca6b, 0xc2b2ae35) ^ lane(idx, 0x2545f491, 0x85ebca6b, 0xc2b2ae35)
  return `${mesh.positions.length / 3}x${mesh.indices.length / 3}-${hex8(a >>> 0)}${hex8(b >>> 0)}${segmentsPart(mesh)}`
}
