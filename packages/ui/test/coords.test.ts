import { describe, expect, it } from 'vitest'
import { fromView, toView } from '../src/coords'

describe('the one conversion between engine (Z up) and view (Y up)', () => {
  it('maps the engine up axis to the view up axis, and round-trips', () => {
    expect(toView([0, 0, 1]).map(v => v + 0)).toEqual([0, 1, 0])
    expect(toView([1, 0, 0])).toEqual([1, 0, 0])
    expect(toView([0, 1, 0]).map(v => v + 0)).toEqual([0, 0, -1])
    for (const p of [[1, 2, 3], [-4, 5, 0.5], [0, 0, 0]] as Array<[number, number, number]>) {
      const back = fromView(toView(p))
      p.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 12))
    }
  })
  it('is a rotation: it keeps the right-handed system (x cross y = z)', () => {
    const x = toView([1, 0, 0]), y = toView([0, 1, 0]), z = toView([0, 0, 1])
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
    cross.forEach((c, i) => expect(c).toBeCloseTo(z[i] as number, 12))
  })
})
