// Reading a picture inside a plugin: bytes in, pixels out. What the pixels mean (a height map, a mask, a colour) is the plugin's business. The engine hands a plugin the bytes of an asset; turning a PNG or JPEG into
// pixels needs the browser's decoder, which is there in a Worker (OffscreenCanvas and createImageBitmap) but not in plain Node.
// The helper says so with a clear error instead of failing in some other way, and it refuses pictures that are too large to hold in memory.
import { MeshError } from './errors'

export interface DecodedImage {
  width: number
  height: number
  /** RGBA, 4 bytes per pixel, row by row from the top. */
  data: Uint8ClampedArray
}

interface Bitmap { width: number; height: number; close?: () => void }
interface Canvas2D { drawImage(b: Bitmap, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }
interface Env {
  createImageBitmap?: (b: Blob) => Promise<Bitmap>
  OffscreenCanvas?: new (w: number, h: number) => { getContext(t: '2d', o?: object): Canvas2D | null }
}

export const DEFAULT_MAX_PIXELS = 64_000_000

export async function decodeImage(bytes: Uint8Array, opts: { mime?: string; maxPixels?: number } = {}): Promise<DecodedImage> {
  const env = globalThis as unknown as Env
  if (!env.createImageBitmap || !env.OffscreenCanvas) throw new MeshError('image.unsupported', { reason: 'no_image_decoder' })
  let bmp: Bitmap
  try { bmp = await env.createImageBitmap(new Blob([bytes as unknown as ArrayBuffer], { type: opts.mime ?? sniff(bytes) })) } catch { throw new MeshError('image.invalid') }
  try {
    const max = opts.maxPixels ?? DEFAULT_MAX_PIXELS
    if (bmp.width * bmp.height > max) throw new MeshError('image.too_large', { width: bmp.width, height: bmp.height, max_pixels: max })
    const ctx = new env.OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new MeshError('image.unsupported', { reason: 'no_2d_context' })
    ctx.drawImage(bmp, 0, 0)
    return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data }
  } finally { bmp.close?.() }
}

function sniff(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp'
  return 'application/octet-stream'
}
