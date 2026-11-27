import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SAMPLES, sampleHash } from '../src/samples'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/samples')
const hashes = JSON.parse(readFileSync(path.join(dir, 'thumbs.json'), 'utf8')) as Record<string, string>

describe('the pre-rendered sample pictures', () => {
  it('are up to date: every sample has a picture drawn for its current definition (run `npm run samples:thumbs` and commit the result)', () => {
    const stale = SAMPLES.filter(s => hashes[s.id] !== sampleHash(s)).map(s => s.id)
    expect(stale, 'stale or missing pictures: run `npm run samples:thumbs`').toEqual([])
    expect(Object.keys(hashes).sort()).toEqual(SAMPLES.map(s => s.id).sort())
  })
  it('are 320 x 220 PNG files of a few KB', () => {
    for (const s of SAMPLES) {
      const b = readFileSync(path.join(dir, `${s.id}.png`))
      expect(b.subarray(1, 4).toString('latin1'), s.id).toBe('PNG')
      expect(b.readUInt32BE(16), `${s.id} width`).toBe(320)
      expect(b.readUInt32BE(20), `${s.id} height`).toBe(220)
      expect(b.length, `${s.id} size`).toBeLessThan(60_000)
    }
  })
  it('change with the definition (a changed step or plugin version gives another hash)', () => {
    const s = SAMPLES.find(x => x.id === 'twist')!
    const other = { ...s, steps: s.steps.map(st => ({ ...st, params: { ...st.params, angle: 121 } })) }
    expect(sampleHash(other)).not.toBe(sampleHash(s))
    expect(sampleHash({ ...s })).toBe(sampleHash(s))
  })
})
