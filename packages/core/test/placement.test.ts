import { describe, expect, it } from 'vitest'
import { checkPlacementLimits, clampPlacementToLimits, placementTravel, validateParams } from '../src'
import type { Operation, PlacementValue } from '../src'

const base: PlacementValue = { anchor: { point: [0, 0, 10], normal: [0, 0, 1], tri: 5 }, direction: 0, limits: { max_distance: 5, direction: [-30, 30], size: [4, 12] } }
const at = (x: number, direction = 0): PlacementValue => ({ ...base, anchor: { point: [x, 0, 10], normal: [0, 0, 1] }, direction })

describe('placement limits', () => {
  it('accepts a placement inside the limits and names each way of leaving them', () => {
    expect(checkPlacementLimits(base, at(3, 20), 8)).toEqual([])
    expect(checkPlacementLimits(base, at(7)).map(e => e.code)).toEqual(['placement.too_far'])
    expect(checkPlacementLimits(base, at(0, 45)).map(e => e.code)).toEqual(['placement.direction_out_of_range'])
    expect(checkPlacementLimits(base, at(0), 20).map(e => e.code)).toEqual(['placement.size_out_of_range'])
    expect(checkPlacementLimits(base, { ...at(0), limits: { max_distance: 500 } }).map(e => e.code)).toEqual(['placement.limits_changed'])
    expect(checkPlacementLimits({ anchor: base.anchor }, at(500, 170).anchor ? { anchor: at(500).anchor, direction: 170 } : base)).toEqual([])  // no limits: nothing to hold to
  })
  it('clamps: the anchor is pulled back along the line to the designer\'s, the direction is clamped', () => {
    const c = clampPlacementToLimits(base, at(20, 80))
    expect(c.anchor.point[0]).toBeCloseTo(5, 9)
    expect(c.anchor.tri).toBeUndefined()
    expect(c.direction).toBe(30)
    expect(checkPlacementLimits(base, c)).toEqual([])
    expect(clampPlacementToLimits(base, at(2, 10))).toEqual(at(2, 10))
    expect(clampPlacementToLimits(base, at(0, -90)).direction).toBe(-30)
  })
})

describe('the customer role holds to the designer\'s limits', () => {
  const op: Operation = { id: 'e', kind: 'modifier', params: [
    { name: 'size', type: 'float', default: 8, min: 1, max: 100, personalisable: true },
    { name: 'placement', type: 'placement', default: null, personalisable: true },
    { name: 'height', type: 'float', default: 1, min: 0.1, max: 5 },
  ] }
  const designer = { size: 8, placement: base, height: 1 }
  it('lets the customer move and resize inside the limits', () => {
    expect(validateParams(op, { size: 10, placement: at(3, 10), height: 1 }, { role: 'customer', base: designer }).ok).toBe(true)
  })
  it('refuses a move too far, a turn too far, a size outside, and changed limits', () => {
    const codes = (p: Record<string, unknown>): string[] => validateParams(op, { height: 1, ...p }, { role: 'customer', base: designer }).errors.map(e => e.code)
    expect(codes({ size: 8, placement: at(9) })).toEqual(['placement.too_far'])
    expect(codes({ size: 8, placement: at(0, -60) })).toEqual(['placement.direction_out_of_range'])
    expect(codes({ size: 30, placement: base })).toEqual(['placement.size_out_of_range'])
    expect(codes({ size: 8, placement: { ...at(1), limits: undefined } })).toEqual(['placement.limits_changed'])
    expect(codes({ size: 8, placement: at(1), height: 2 })).toEqual(['param.not_editable'])
  })
  it('a shift on the map counts as moving: it cannot be used to get around max_distance', () => {
    const shifted = (dx: number): PlacementValue => ({ ...base, offset: [dx, 0] })
    expect(checkPlacementLimits(base, shifted(4))).toEqual([])
    expect(checkPlacementLimits(base, shifted(6)).map(e => e.code)).toEqual(['placement.too_far'])
    const both = { ...at(3), offset: [4, 0] as [number, number] }       // 3 + 4 = 7 > 5
    expect(checkPlacementLimits(base, both).map(e => e.code)).toEqual(['placement.too_far'])
    const c = clampPlacementToLimits(base, both)
    expect(placementTravel(base, c)).toBeLessThanOrEqual(5 + 1e-9)
    expect(c.anchor.point[0]).toBe(3)                                     // the anchor stays, the shift is cut back to what is left
    expect(c.offset![0]).toBeCloseTo(2, 9)
    expect(clampPlacementToLimits(base, { ...at(20), offset: [3, 3] }).offset).toEqual([0, 0])
  })

  it('the designer is not bound by their own limits, and a malformed limits object is refused', () => {
    expect(validateParams(op, { size: 50, placement: at(99), height: 1 }, { role: 'designer' }).ok).toBe(true)
    const bad = (limits: unknown): string | undefined => validateParams(op, { size: 8, placement: { ...base, limits }, height: 1 }).errors[0]?.params?.['field'] as string | undefined
    expect(bad({ max_distance: -1 })).toBe('limits.max_distance')
    expect(bad({ direction: [30, -30] })).toBe('limits.direction')
    expect(bad({ direction: [-200, 0] })).toBe('limits.direction')
    expect(bad({ size: [5] })).toBe('limits.size')
    expect(bad('x')).toBe('limits')
    expect(bad({ max_distance: 3, direction: [-10, 10], size: [1, 2], size_param: 'size' })).toBeUndefined()
  })
})

import { IDENTITY4, cumulativeMatrix, followEarlierSteps, invert4, mul4, transformPlacement } from '../src'

describe('following earlier steps', () => {
  const scale2: number[] = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]
  const move: number[] = [1, 0, 0, 5, 0, 1, 0, -2, 0, 0, 1, 1, 0, 0, 0, 1]
  it('inverts affine matrices', () => {
    const m = mul4(move, scale2)
    const back = mul4(m, invert4(m)!)
    back.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY4[i]!, 12))
    expect(invert4([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull()
  })
  it('moves the point with the matrix and the normal with its inverse transpose (non-uniform scale tilts normals correctly)', () => {
    const p = transformPlacement({ anchor: { point: [1, 1, 1], normal: [0, 0, 1], tri: 3 } }, mul4(move, scale2))
    expect(p.anchor.point).toEqual([7, 0, 3])
    expect(p.anchor.tri).toBeUndefined()
    // a 45 degree slope stretched 2x along z: its normal (1,0,1)/sqrt2 must become (2,0,1)/sqrt5
    const s: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]
    const q = transformPlacement({ anchor: { point: [0, 0, 0], normal: [Math.SQRT1_2, 0, Math.SQRT1_2] } }, s)
    expect(q.anchor.normal[0]).toBeCloseTo(2 / Math.sqrt(5), 9); expect(q.anchor.normal[2]).toBeCloseTo(1 / Math.sqrt(5), 9)
  })
  it('carries the reading direction with the part, and keeps it when the turn is about the normal only for a world-up reference', () => {
    const rotZ90: number[] = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    // on a top face with the up reference parallel to the normal the frame falls back to world Y: text reads along +x; turned 90 degrees it reads along +y
    const top = transformPlacement({ anchor: { point: [1, 0, 0], normal: [0, 0, 1] }, direction: 0 }, rotZ90)
    expect(top.direction).toBeCloseTo(90, 9)
    expect(transformPlacement({ anchor: { point: [1, 0, 0], normal: [0, 0, 1] }, direction: 30 }, rotZ90).direction).toBeCloseTo(120, 9)
    // a wall facing -y with world Z up reads along +x; turning the part about z by 90 degrees makes the wall face +x, and the text still stands upright
    const wall = transformPlacement({ anchor: { point: [0, -5, 3], normal: [0, -1, 0] }, direction: 0 }, rotZ90)
    expect(wall.anchor.normal[0]).toBeCloseTo(1, 9)
    expect(wall.direction).toBeCloseTo(0, 9)
    // a pure move changes nothing
    expect(transformPlacement({ anchor: { point: [0, 0, 0], normal: [0, 0, 1] }, direction: 45 }, [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).direction).toBeCloseTo(45, 9)
  })
  it('multiplies the reported matrices of the steps before, skipping disabled ones', () => {
    const results = [{ report: { matrix: scale2 } }, { status: 'disabled', report: { matrix: move } }, { report: { matrix: move } }, { report: {} }]
    expect(cumulativeMatrix(results, 0)).toEqual(IDENTITY4)
    expect(cumulativeMatrix(results, 4)).toEqual(mul4(move, scale2))
  })
  it('changes nothing when the earlier steps are as they were, and carries the anchor when they are not', () => {
    const prep = followEarlierSteps<{ params: Record<string, unknown> }>()
    const step = { params: { placement: { anchor: { point: [1, 1, 1], normal: [0, 0, 1] }, frame: IDENTITY4 } } }
    expect(prep(step, 0, [])).toBe(step)
    const moved = prep(step, 1, [{ report: { matrix: scale2 } }]).params['placement'] as PlacementValue
    expect(moved.anchor.point).toEqual([2, 2, 2])
    expect(step.params.placement.anchor.point).toEqual([1, 1, 1])   // the stored step is not changed
    expect(prep({ params: { placement: { anchor: { point: [1, 1, 1], normal: [0, 0, 1] } } } }, 1, [{ report: { matrix: scale2 } }]).params['placement']).toEqual({ anchor: { point: [1, 1, 1], normal: [0, 0, 1] } })  // no frame recorded
  })
  it('carries the placements in the rows of a list too (several clicked points), and leaves other rows alone', () => {
    const prep = followEarlierSteps<{ params: Record<string, unknown> }>()
    const row = (x: number): Record<string, unknown> => ({ at: { anchor: { point: [x, 1, 1], normal: [0, 0, 1] }, frame: IDENTITY4 }, size: 3 })
    const step = { params: { points: [row(1), row(2), { size: 4 }] } }
    expect(prep(step, 0, [])).toBe(step)
    const out = prep(step, 1, [{ report: { matrix: scale2 } }]).params['points'] as Array<Record<string, unknown>>
    expect((out[0]!['at'] as PlacementValue).anchor.point).toEqual([2, 2, 2])
    expect((out[1]!['at'] as PlacementValue).anchor.point).toEqual([4, 2, 2])
    expect(out[0]!['size']).toBe(3)
    expect(out[2]).toBe((step.params.points as unknown[])[2])
  })
})
