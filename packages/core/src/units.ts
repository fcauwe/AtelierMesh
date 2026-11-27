// Units. The engine works in millimetres; a file may say otherwise, or say nothing.
import type { Mesh, Vec3 } from './types'
import { boundingSize } from './measure'

export type Unit = 'mm' | 'cm' | 'm' | 'inch' | 'micron' | 'foot'

/** Millimetres per unit. */
export const UNIT_TO_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4, micron: 0.001, foot: 304.8 }

export function scaleMesh(mesh: Mesh, factor: number): Mesh {
  if (factor === 1) return mesh
  const positions = new Float64Array(mesh.positions.length)
  for (let i = 0; i < positions.length; i++) positions[i] = (mesh.positions[i] as number) * factor
  return { ...mesh, positions }
}

export function convertToMm(mesh: Mesh, from: Unit): Mesh {
  return scaleMesh(mesh, UNIT_TO_MM[from])
}

export interface UnitHint {
  /** The unit the size makes more likely than millimetres, or null when millimetres look plausible. */
  suspect: Unit | null
  size: Vec3
  reason: 'tiny' | 'small' | 'huge' | null
}

/**
 * A guess, not a rule: a part that is a fraction of a millimetre was probably in metres, one a few units across probably in inches
 * (a 100 mm part reads as 3.9), and one thousands of units across probably in micrometres. Only a hint for the user to confirm.
 */
export function unitHint(mesh: Mesh): UnitHint {
  const size = boundingSize(mesh)
  const max = Math.max(size[0], size[1], size[2])
  if (max === 0) return { suspect: null, size, reason: null }
  if (max < 0.5) return { suspect: 'm', size, reason: 'tiny' }
  if (max < 6) return { suspect: 'inch', size, reason: 'small' }
  if (max > 2000) return { suspect: 'micron', size, reason: 'huge' }
  return { suspect: null, size, reason: null }
}
