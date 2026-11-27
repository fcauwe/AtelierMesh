// Small 3-vector helpers for the emboss code. Plain arrays; the hot loops use typed arrays instead.
export type V3 = [number, number, number]
export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const vnorm = (a: V3): V3 => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
