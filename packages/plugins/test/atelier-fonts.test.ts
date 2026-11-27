import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runWorkflow } from '@ateliermesh/core'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from '../src'
import { gridBox } from './parts'

// Every font the Atelier offers, with accents, raised on a plate. Skipped when the Atelier checkout is not next to this one.
const ATELIER = fileURLToPath(new URL('../../../assets/atelier/frontend', import.meta.url))
const cfg = path.join(ATELIER, 'src/config/fonts.ts')
const d = fs.existsSync(cfg) ? describe : describe.skip
const wawoff = createRequire(import.meta.url)('wawoff2') as { decompress(b: Uint8Array): Promise<Uint8Array> }

const fonts = fs.existsSync(cfg)
  ? [...fs.readFileSync(cfg, 'utf8').matchAll(/family:\s*'([^']+)',\s*url:\s*'([^']+)'(?:,\s*weightRange:\s*'([^']+)')?/g)].map(m => ({ family: m[1]!, url: m[2]!, range: m[3] }))
  : []

d('the Atelier fonts', () => {
  const plate = gridBox(70, 30, 4, 140, 60, 8)
  it('Bpmf Iansui reports the character it lacks', async () => {
    const f = fonts.find(x => x.family === 'Bpmf Iansui')!
    const bytes = new Uint8Array(fs.readFileSync(path.join(ATELIER, 'public', f.url)))
    const step = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { font: 'f', text: 'Éloïse', size: 7, placement: { anchor: { point: [0, 0, 4], normal: [0, 0, 1] } } } })
    const r = await runWorkflow(addStep(emptyStepList(), step), { registry: new Registry().register(corePlugin()), source: plate, assets: async () => bytes })
    expect(r.results[0]!.error).toMatchObject({ code: 'emboss.missing_glyphs', params: { characters: ['ï'] } })
  })
  it('finds the seventeen fonts', () => { expect(fonts.length).toBe(17) })
  // Bpmf Iansui has no "ï" and Autery has no accents at all: the engine says so by name instead of drawing a blank
  const TEXT: Record<string, string> = { 'Bpmf Iansui': 'Anna Eloise', 'Autery': 'Anna Eloise' }
  for (const f of fonts) {
    it(`${f.family}${f.range ? ` (variable ${f.range})` : ''}: "${TEXT[f.family] ?? 'Anna Éloïse'}" raised as one closed mesh`, async () => {
      const raw = new Uint8Array(fs.readFileSync(path.join(ATELIER, 'public', f.url)))
      const bytes = f.range ? await wawoff.decompress(raw) : raw
      const weights = f.range ? [Number(f.range.split(' ')[0]), Number(f.range.split(' ')[1])] : [400]
      for (const weight of weights) {
        const step = makeStep({ id: 'e', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { font: 'f', text: TEXT[f.family] ?? 'Anna Éloïse', size: 7, weight, height: 0.6, placement: { anchor: { point: [0, 0, 4], normal: [0, 0, 1] } } } })
        const r = await runWorkflow(addStep(emptyStepList(), step), { registry: new Registry().register(corePlugin()), source: plate, assets: async () => bytes })
        const res = r.results[0]!
        expect(res.status, `${f.family} @${weight}: ${JSON.stringify(res.error)}`).toBe('ok')
        expect(measureMesh(res.mesh!).watertight, `${f.family} @${weight}`).toBe(true)
        expect(res.report!['volume_estimate'] as number, `${f.family} @${weight}`).toBeGreaterThan(5)
      }
    })
  }
})
