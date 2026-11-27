import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeHeightImage } from '../src'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/standalone/public/textures')
const list = JSON.parse(fs.readFileSync(path.join(dir, 'textures.json'), 'utf8')) as Array<{ id: string; name: string; category: string; file: string }>

describe('the standalone picture library (public/textures)', () => {
  it('lists ten pictures with unique ids and existing files', () => {
    expect(list.length).toBe(10)
    expect(new Set(list.map(x => x.id)).size).toBe(10)
    for (const x of list) { expect(x.id).toMatch(/^texture:[a-z]+$/); expect(fs.existsSync(path.join(dir, '..', x.file))).toBe(true) }
  })
  it('every picture reads as heights, uses a real range and repeats without a seam', async () => {
    for (const x of list) {
      const img = await decodeHeightImage(new Uint8Array(fs.readFileSync(path.join(dir, '..', x.file))))
      expect([img.width, img.height]).toEqual([128, 128])
      let lo = 1, hi = 0
      for (const v of img.data) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
      expect(hi - lo, x.id).toBeGreaterThan(0.4)
      // the step across the edge is no bigger than the biggest step inside
      let inner = 0, edge = 0
      for (let y = 0; y < 128; y++) { for (let c = 0; c < 127; c++) inner = Math.max(inner, Math.abs((img.data[y * 128 + c + 1] as number) - (img.data[y * 128 + c] as number))); edge = Math.max(edge, Math.abs((img.data[y * 128] as number) - (img.data[y * 128 + 127] as number))) }
      expect(edge, x.id).toBeLessThanOrEqual(inner + 1e-6)
    }
  })
})
