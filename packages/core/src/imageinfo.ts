// What an example image of a plugin may be: PNG, JPEG or WebP, found by its first bytes (never by its file name), with its size read from the header.
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'
export interface ImageInfo { mime: ImageMime; width: number; height: number }

export const PLUGIN_IMAGE_LIMITS = { maxBytes: 300 * 1024, maxWidth: 1600, maxHeight: 1200, minWidth: 200 } as const
/** The manifest's `image.file` path: relative, no `..`, 1 to 100 characters. */
export const IMAGE_PATH_RE = /^[A-Za-z0-9_./-]{1,100}$/
export const imagePathOk = (p: string): boolean => IMAGE_PATH_RE.test(p) && !p.startsWith('/') && !p.split('/').some(s => s === '..' || s === '' || s === '.')

/** Reads the type and size of a PNG, JPEG or WebP picture from its header; null when it is none of these or the header is cut off. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const u32 = (o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: 'image/png', width: u32(16), height: u32(20) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const m = b[o + 1]!
      if (m === 0xff) { o++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue }
      const len = (b[o + 2]! << 8) | b[o + 3]!
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', height: (b[o + 5]! << 8) | b[o + 6]!, width: (b[o + 7]! << 8) | b[o + 8]! }
      if (len < 2) return null
      o += 2 + len
    }
    return null
  }
  const tag = (o: number, s: string): boolean => b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (b.length >= 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8 ')) return { mime: 'image/webp', width: ((b[26]! | (b[27]! << 8)) & 0x3fff), height: ((b[28]! | (b[29]! << 8)) & 0x3fff) }
    if (tag(12, 'VP8L')) { const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0; return { mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 } }
    if (tag(12, 'VP8X')) return { mime: 'image/webp', width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 }
  }
  return null
}

/** The problem with picture bytes, as a code for `package.image_*` errors, or null when they are fine. */
export function imageBytesProblem(bytes: Uint8Array): { code: string; params: Record<string, unknown> } | null {
  const L = PLUGIN_IMAGE_LIMITS
  const info = sniffImage(bytes)
  if (!info) return { code: 'package.image_type', params: {} }
  if (bytes.length > L.maxBytes) return { code: 'package.image_too_big', params: { bytes: bytes.length, max: L.maxBytes } }
  if (info.width < L.minWidth || info.width > L.maxWidth || info.height < 1 || info.height > L.maxHeight) return { code: 'package.image_dimensions', params: { width: info.width, height: info.height, minWidth: L.minWidth, maxWidth: L.maxWidth, maxHeight: L.maxHeight } }
  return null
}
