import { describe, expect, it } from 'vitest'
import { emptyStepList } from '@ateliermesh/core'
import type { Drawing } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import { projectSignature, storedName } from '../src/useProjectSession'
import type { ProjectDoc } from '../src/useProjectSession'

const square: Drawing = { kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [1, 0], [1, 1], [0, 1]] }] }
const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc => { const m = boxMesh(10, 10, 10); return { base: m, source: m, name: 'p', list: emptyStepList(), rollback: null, store: {}, ...over } }

describe('stored item names', () => {
  it('make a valid name from a file name: lower case, digits and underscores, starting with a letter', () => {
    expect(storedName('My Star.svg', {})).toBe('my_star')
    expect(storedName('2024 logo (v2).svg', {})).toBe('logo_v2_')
    expect(storedName('日本語.svg', {})).toBe('item')
    expect(storedName('', {})).toBe('item')
    expect(storedName('x'.repeat(80) + '.svg', {}).length).toBe(36)
  })
  it('are made unique against the store', () => {
    const taken = { my_star: { payload: square }, my_star_2: { payload: square } }
    expect(storedName('My Star.svg', taken)).toBe('my_star_3')
    expect(storedName('other.svg', taken)).toBe('other')
  })
})

describe('the project signature (unsaved changes)', () => {
  it('is the same for the same project and changes with the name, the steps, the rollback marker and the store', () => {
    const a = projectSignature(doc())
    expect(projectSignature(doc())).toBe(a)
    expect(projectSignature(doc({ name: 'q' }))).not.toBe(a)
    expect(projectSignature(doc({ rollback: 's1' }))).not.toBe(a)
    expect(projectSignature(doc({ store: { logo: { payload: square } } }))).not.toBe(a)
  })
  it('sees a changed drawing under the same name', () => {
    const bigger: Drawing = { kind: 'drawing', paths: [{ closed: true, points: [[0, 0], [2, 0], [2, 2], [0, 2]] }] }
    expect(projectSignature(doc({ store: { logo: { payload: square } } }))).not.toBe(projectSignature(doc({ store: { logo: { payload: bigger } } })))
  })
})
