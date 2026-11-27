// Reading a picture as a height map: the luminance of every pixel, 0 (black) to 1 (white).
//
// PNG is read by a small decoder in this file (8 and 16 bit grey, grey with alpha, RGB, RGBA and palette pictures, not interlaced), so it gives the
// same numbers in every browser, in a worker and in Node. The inflate step uses the platform's `DecompressionStream`, which every browser and Node 18+
// have. Other formats (JPEG, WebP) go through `createImageBitmap` and an `OffscreenCanvas` when the platform has them, which a worker in a current browser does;
// without them the error is `texture.image_unsupported`. A picture is at most 8192 pixels on a side; one above 2048 is averaged down to that.
import { MeshError } from '@ateliermesh/core'

export interface HeightImage { width: number; height: number; data: Float32Array }

const MAX_SIDE = 8192
const WORK_SIDE = 2048

const isPng = (b: Uint8Array): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new MeshError('texture.image_unsupported', { reason: 'no_inflate' })
  const ds = new DecompressionStream('deflate')
  const w = ds.writable.getWriter()
  void w.write(data as unknown as BufferSource).then(() => w.close()).catch(() => undefined)
  const chunks: Uint8Array[] = []
  const r = ds.readable.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    chunks.push(value as Uint8Array); total += value.length
    if (total > 512 * 1024 * 1024) throw new MeshError('texture.image_too_large', { reason: 'inflated_size' })
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

const be32 = (b: Uint8Array, i: number): number => ((b[i] as number) * 16777216) + ((b[i + 1] as number) << 16) + ((b[i + 2] as number) << 8) + (b[i + 3] as number)

async function decodePng(bytes: Uint8Array): Promise<HeightImage> {
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0
  let palette: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let p = 8
  while (p + 8 <= bytes.length) {
    const len = be32(bytes, p), type = String.fromCharCode(bytes[p + 4] as number, bytes[p + 5] as number, bytes[p + 6] as number, bytes[p + 7] as number)
    const body = bytes.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = be32(body, 0); h = be32(body, 4); depth = body[8] as number; color = body[9] as number; interlace = body[12] as number }
    else if (type === 'PLTE') palette = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (w <= 0 || h <= 0) throw new MeshError('texture.image_unsupported', { reason: 'bad_png' })
  if (w > MAX_SIDE || h > MAX_SIDE) throw new MeshError('texture.image_too_large', { width: w, height: h, max: MAX_SIDE })
  if (interlace !== 0) throw new MeshError('texture.image_unsupported', { reason: 'interlaced_png' })
  if (depth !== 8 && depth !== 16) throw new MeshError('texture.image_unsupported', { reason: 'png_bit_depth', depth })
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0
  if (channels === 0) throw new MeshError('texture.image_unsupported', { reason: 'png_colour_type', color })
  if (color === 3 && depth !== 8) throw new MeshError('texture.image_unsupported', { reason: 'png_palette_depth', depth })
  const total = idat.reduce((n, c) => n + c.length, 0)
  const z = new Uint8Array(total)
  let o = 0
  for (const c of idat) { z.set(c, o); o += c.length }
  const raw = await inflate(z)
  const bpp = channels * (depth / 8), stride = w * bpp
  if (raw.length < (stride + 1) * h) throw new MeshError('texture.image_unsupported', { reason: 'png_truncated' })
  const img = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] as number
    const src = y * (stride + 1) + 1, dst = y * stride
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x] as number
      const a = x >= bpp ? (img[dst + x - bpp] as number) : 0
      const b = y > 0 ? (img[dst - stride + x] as number) : 0
      const c = x >= bpp && y > 0 ? (img[dst - stride + x - bpp] as number) : 0
      let v: number
      switch (f) {
        case 0: v = cur; break
        case 1: v = cur + a; break
        case 2: v = cur + b; break
        case 3: v = cur + ((a + b) >> 1); break
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break }
        default: throw new MeshError('texture.image_unsupported', { reason: 'png_filter' })
      }
      img[dst + x] = v & 255
    }
  }
  const out = new Float32Array(w * h)
  const sample = (i: number): number => (depth === 8 ? (img[i] as number) / 255 : (((img[i] as number) << 8) | (img[i + 1] as number)) / 65535)
  const step = depth / 8
  for (let i = 0; i < w * h; i++) {
    const px = i * bpp
    let lum: number
    if (color === 0 || color === 4) lum = sample(px)
    else if (color === 3) { const idx = img[px] as number; lum = palette ? (0.2126 * (palette[3 * idx] as number) + 0.7152 * (palette[3 * idx + 1] as number) + 0.0722 * (palette[3 * idx + 2] as number)) / 255 : 0 }
    else lum = 0.2126 * sample(px) + 0.7152 * sample(px + step) + 0.0722 * sample(px + 2 * step)
    out[i] = lum
  }
  return { width: w, height: h, data: out }
}

async function decodeWithPlatform(bytes: Uint8Array): Promise<HeightImage> {
  const g = globalThis as unknown as { createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close?: () => void }>; OffscreenCanvas?: new (w: number, h: number) => { getContext(t: string): { drawImage(i: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null } }
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') throw new MeshError('texture.image_unsupported', { reason: 'format_needs_browser' })
  let bmp: Awaited<ReturnType<NonNullable<typeof g.createImageBitmap>>>
  try { bmp = await g.createImageBitmap(new Blob([bytes as unknown as BlobPart])) } catch { throw new MeshError('texture.image_unsupported', { reason: 'unreadable' }) }
  if (bmp.width > MAX_SIDE || bmp.height > MAX_SIDE) throw new MeshError('texture.image_too_large', { width: bmp.width, height: bmp.height, max: MAX_SIDE })
  const cv = new g.OffscreenCanvas(bmp.width, bmp.height), ctx = cv.getContext('2d')
  if (!ctx) throw new MeshError('texture.image_unsupported', { reason: 'no_canvas' })
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const out = new Float32Array(bmp.width * bmp.height)
  for (let i = 0; i < out.length; i++) out[i] = (0.2126 * (px[4 * i] as number) + 0.7152 * (px[4 * i + 1] as number) + 0.0722 * (px[4 * i + 2] as number)) / 255
  const r = { width: bmp.width, height: bmp.height, data: out }
  bmp.close?.()
  return r
}

/** Average a big picture down so its longest side is at most `WORK_SIDE`. */
function reduce(img: HeightImage): HeightImage {
  const k = Math.ceil(Math.max(img.width, img.height) / WORK_SIDE)
  if (k <= 1) return img
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += img.data[(y * k + j) * img.width + x * k + i] as number
    out[y * w + x] = s / (k * k)
  }
  return { width: w, height: h, data: out }
}

/** A picture as a height map. Throws `texture.image_unsupported` or `texture.image_too_large`. */
export async function decodeHeightImage(bytes: Uint8Array): Promise<HeightImage> {
  if (!bytes || bytes.length < 8) throw new MeshError('texture.image_unsupported', { reason: 'empty' })
  return reduce(isPng(bytes) ? await decodePng(bytes) : await decodeWithPlatform(bytes))
}

/** The height at tile coordinates (u, v) in 0..1, bilinear. Outside 0..1 the picture repeats (`wrap`) or gives 0. */
export function sampleImage(img: HeightImage, u: number, v: number, wrap: boolean): number {
  let x = u, y = v
  if (wrap) { x -= Math.floor(x); y -= Math.floor(y) } else if (x < 0 || x > 1 || y < 0 || y > 1) return 0
  const fx = x * img.width - 0.5, fy = (1 - y) * img.height - 0.5   // v grows upwards on the surface, rows grow downwards in a picture
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0
  const at = (i: number, j: number): number => {
    const ii = wrap ? ((i % img.width) + img.width) % img.width : Math.min(img.width - 1, Math.max(0, i))
    const jj = wrap ? ((j % img.height) + img.height) % img.height : Math.min(img.height - 1, Math.max(0, j))
    return img.data[jj * img.width + ii] as number
  }
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1)
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}
