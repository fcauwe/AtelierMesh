import { describe, expect, it } from 'vitest'
import { assetKind, isPicture } from '../src/assetkind'

describe('which picker an asset setting gets', () => {
  it('a picture gallery is a picture, not a font (the Texture and Lithophane image settings)', () => {
    expect(assetKind({ widget: 'gallery', accept: ['image/png', 'image/jpeg'] })).toBe('image')
    expect(assetKind({ widget: 'gallery', accept: ['image/webp'] })).toBe('image')
  })
  it('fonts stay fonts, a drawing stays a drawing', () => {
    expect(assetKind({ widget: 'font', accept: ['font'] })).toBe('font')
    expect(assetKind({ accept: ['font'] })).toBe('font')
    expect(assetKind({ accept: ['image/svg+xml'] })).toBe('svg')
  })
  it('an unknown or missing type list is a plain file, a gallery without one never a font', () => {
    expect(assetKind({ widget: 'gallery' })).toBe('file')
    expect(assetKind({ accept: ['application/octet-stream'] })).toBe('file')
    expect(assetKind({})).toBe('font')
  })
  it('knows a picture from a font by the first bytes', () => {
    expect(isPicture(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10]))).toBe(true)
    expect(isPicture(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(isPicture(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(true)
    expect(isPicture(Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 1]))).toBe(false)   // a woff2 font
    expect(isPicture(Uint8Array.from([0, 1, 0, 0, 0, 0]))).toBe(false)               // a TrueType font
  })
})
