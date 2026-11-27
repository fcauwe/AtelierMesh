import { describe, expect, it } from 'vitest'
import { read3mf, readZip, write3mf, write3mfCompressed } from '../src'
import { sphereMesh } from '../src/testing'

describe('write3mfCompressed', () => {
  it('is smaller than the stored file, reads back to the same mesh and gives the same bytes twice', async () => {
    const m = sphereMesh(10, 3)
    const a = write3mf(m, { slicer: 'none' }), b = await write3mfCompressed(m, { slicer: 'none' })
    expect(b.bytes.length).toBeLessThan(a.bytes.length / 2)
    const back = await read3mf(b.bytes)
    expect(Array.from(back.mesh.indices)).toEqual(Array.from(m.indices))
    expect(Array.from(back.mesh.positions)).toEqual(Array.from(m.positions))
    expect(Array.from((await write3mfCompressed(m, { slicer: 'none' })).bytes)).toEqual(Array.from(b.bytes))
    expect((await readZip(b.bytes)).map(e => e.name)).toContain('3D/3dmodel.model')
  })
})

describe('buildPackageCompressed', () => {
  it('holds the same files as buildPackage and is smaller', async () => {
    const { buildPackage, buildPackageCompressed, emptyStepList, readZip } = await import('../src')
    const m = sphereMesh(10, 3)
    const input = { source: m, final: m, steps: emptyStepList(), slicer: 'none' as const }
    const a = buildPackage(input), b = await buildPackageCompressed(input)
    expect(b.length).toBeLessThan(a.length / 2)
    const names = async (z: Uint8Array) => (await readZip(z)).map(e => e.name)
    expect(await names(b)).toEqual(await names(a))
    const fin = (await readZip(b)).find(e => e.name === 'final.3mf')!
    expect((await read3mf(fin.data)).mesh.indices.length).toBe(m.indices.length)
  })
})
