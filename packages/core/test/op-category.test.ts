import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src'

const base = (category?: unknown): unknown => ({ manifest_version: 1, id: 'org.example.c', name: 'C', version: '1.0.0', operations: [{ id: 'op', kind: 'modifier', params: [], ...(category !== undefined ? { category } : {}) }] })

describe('operation category', () => {
  it('is optional and accepts a lowercase id', () => {
    expect(validateManifest(base()).ok).toBe(true)
    expect(validateManifest(base('surface')).ok).toBe(true)
    expect(validateManifest(base('my_group')).ok).toBe(true)
  })
  it('refuses anything else', () => {
    expect(validateManifest(base('Not Valid')).ok).toBe(false)
    expect(validateManifest(base(5)).ok).toBe(false)
  })
})
