import { afterEach, describe, expect, it, vi } from 'vitest'
import { newProjectId } from '../src/library'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('a new project id on a page that is not a secure context', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('uses randomUUID when the browser has it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555', getRandomValues: () => { throw new Error('not needed') } })
    expect(newProjectId()).toBe('11111111-2222-4333-8444-555555555555')
  })
  it('falls back to getRandomValues when randomUUID is missing (plain http on a phone)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => { a.forEach((_, i) => { a[i] = (i * 37 + 11) & 255 }); return a } })
    const id = newProjectId()
    expect(id).toMatch(UUID)
    expect(newProjectId()).toBe(id)   // same stub bytes, same id: it really used them
  })
  it('still makes an id when there is no crypto at all, and two ids differ', () => {
    vi.stubGlobal('crypto', undefined)
    const a = newProjectId(), b = newProjectId()
    expect(a).toMatch(UUID); expect(b).toMatch(UUID); expect(a).not.toBe(b)
  })
})
