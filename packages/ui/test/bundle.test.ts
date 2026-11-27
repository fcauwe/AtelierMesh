import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// The host app below stands for any host: it imports three itself, and loads the viewer on demand.
const host = `
import * as THREE from 'three'
import { loadViewer } from '@ateliermesh/ui'
export async function show(el) { const { createViewer } = await loadViewer(); return createViewer(THREE, el) }
`

describe('bundling', () => {
  it('puts the viewer in its own chunk and builds in exactly one copy of three.js', async () => {
    const r = await build({
      stdin: { contents: host, resolveDir: here, loader: 'js' },
      bundle: true, splitting: true, format: 'esm', outdir: 'out', write: false, minify: false, logLevel: 'silent',
    })
    const files = r.outputFiles.map(f => ({ name: path.basename(f.path), text: f.text }))
    const chunkWithViewer = files.filter(f => f.text.includes('snapshot failed'))
    expect(chunkWithViewer.length).toBe(1)
    const main = files.find(f => !f.name.startsWith('chunk-') && f.name !== chunkWithViewer[0]?.name) ?? files[0]!
    expect(main.text).not.toContain('snapshot failed')           // the viewer is not in the main bundle
    expect(files.length).toBeGreaterThan(1)
    const copies = files.reduce((n, f) => n + (f.text.match(/var REVISION = /g)?.length ?? 0), 0)
    expect(copies).toBe(1)                                        // one three.js, shared
  })
})
