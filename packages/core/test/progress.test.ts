import { describe, expect, it } from 'vitest'
import { parseStl, parseStlAsync, read3mf, write3mf, writeStlBinary, weldSoup, weldSoupAsync } from '../src'
import { sphereMesh } from '../src/testing'

// a mesh big enough for several chunks (CHUNK is 60 000 triangles)
const big = (): ReturnType<typeof sphereMesh> => sphereMesh(10, 7)

describe('reading with progress', () => {
  it('STL: progress rises, ends at 1, and the mesh equals the synchronous one', async () => {
    const bytes = writeStlBinary(big())
    const seen: number[] = []
    const a = await parseStlAsync(bytes, { onProgress: f => seen.push(f) })
    const b = parseStl(bytes)
    expect(a.mesh.positions).toEqual(b.mesh.positions)
    expect(a.mesh.indices).toEqual(b.mesh.indices)
    expect(seen.length).toBeGreaterThan(2)
    expect(seen.every((f, i) => i === 0 || f >= (seen[i - 1] as number))).toBe(true)
    expect(seen.at(-1)).toBe(1)
    expect(seen.every(f => f >= 0 && f <= 1)).toBe(true)
  })
  it('STL: stopping with a signal rejects with AbortError and returns nothing', async () => {
    const bytes = writeStlBinary(big())
    const ac = new AbortController()
    const p = parseStlAsync(bytes, { signal: ac.signal, onProgress: () => ac.abort() })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('weld: async equals sync', async () => {
    const m = big()
    const soup = new Float64Array(m.indices.length * 3)
    for (let i = 0; i < m.indices.length; i++) for (let k = 0; k < 3; k++) soup[3 * i + k] = m.positions[3 * (m.indices[i] as number) + k] as number
    const a = await weldSoupAsync(soup), b = weldSoup(soup)
    expect(a.mesh.indices).toEqual(b.mesh.indices)
    expect(a.degenerate).toBe(b.degenerate)
  })
  it('3MF: progress rises to 1 and the result is unchanged', async () => {
    const bytes = write3mf(big(), { slicer: 'none' }).bytes
    const seen: number[] = []
    const a = await read3mf(bytes, { onProgress: f => seen.push(f) })
    const b = await read3mf(bytes)
    expect(a.mesh.indices.length).toBe(b.mesh.indices.length)
    expect(seen.length).toBeGreaterThan(3)
    expect(seen.every((f, i) => i === 0 || f >= (seen[i - 1] as number))).toBe(true)
    expect(seen.at(-1)).toBe(1)
  })
  it('3MF: a signal stops it', async () => {
    const bytes = write3mf(big(), { slicer: 'none' }).bytes
    const ac = new AbortController()
    await expect(read3mf(bytes, { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
