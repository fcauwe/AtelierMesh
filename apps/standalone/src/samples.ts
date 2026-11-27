// The samples on the start page: the data lives in @ateliermesh/plugins (`sample-defs.ts`); this file adds the card pictures and names.
import { hashJson } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION, VORONOI_PLUGIN_ID, VORONOI_PLUGIN_VERSION, TEXTURE_PLUGIN_ID, TEXTURE_PLUGIN_VERSION, HOLLOW_PLUGIN_ID, HOLLOW_PLUGIN_VERSION, HOLES_PLUGIN_ID, HOLES_PLUGIN_VERSION, LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION, SAMPLES, sample, sampleSteps } from '@ateliermesh/plugins'
import type { BaseSpec, Sample } from '@ateliermesh/plugins'
export { SAMPLES, sampleSteps }
export type { BaseSpec, Sample }

/** The pictures in the plugin gallery: for a built-in plugin the sample that shows it best (public/plugins/<plugin id>.png, drawn by `npm run plugins:images`). */
const lowpolyExample = sample('lowpoly', 'Low-poly sphere', { kind: 'sphere', r: 18, subdivisions: 5 },
  [{ plugin: LOWPOLY_PLUGIN_ID, op: 'low_poly', name: 'Low poly', params: { triangles_mode: 'fixed', triangles: 300, crystallise: 0.6 } }])
const byId = (id: string): Sample => SAMPLES.find(x => x.id === id) ?? lowpolyExample
export const PLUGIN_EXAMPLES: Array<{ plugin: string; sample: Sample }> = ([
  [CORE_PLUGIN_ID, 'nametag'], [DEFORM_PLUGIN_ID, 'twist'], [VORONOI_PLUGIN_ID, 'voronoishell'], [TEXTURE_PLUGIN_ID, 'texblock'],
  [HOLLOW_PLUGIN_ID, 'hollowjar'], [HOLES_PLUGIN_ID, 'keyringtag'], [LOWPOLY_PLUGIN_ID, 'lowpoly'],
] as const).map(([plugin, id]) => ({ plugin, sample: byId(id) }))

/** The name in the chosen language (`sample.<id>` in the locale files), else the English one above. */
export const sampleName = (t: (key: string) => string, sample: Sample): string => { const v = t(`sample.${sample.id}`); return v === `sample.${sample.id}` ? sample.name : v }

// ------------------------------------------------------------------ the pre-rendered pictures

/** Bump when the way the pictures are drawn changes (size, angle, colours). A change to a plugin's output shows as a new plugin version. */
export const THUMB_VERSION = 1
const PLUGIN_VERSIONS: Record<string, string> = { [LOWPOLY_PLUGIN_ID]: LOWPOLY_PLUGIN_VERSION, [CORE_PLUGIN_ID]: CORE_PLUGIN_VERSION, [HOLES_PLUGIN_ID]: HOLES_PLUGIN_VERSION, [VORONOI_PLUGIN_ID]: VORONOI_PLUGIN_VERSION, [DEFORM_PLUGIN_ID]: DEFORM_PLUGIN_VERSION, [TEXTURE_PLUGIN_ID]: TEXTURE_PLUGIN_VERSION, [HOLLOW_PLUGIN_ID]: HOLLOW_PLUGIN_VERSION }

/** What the picture of a sample depends on: the base shape, the steps with their settings, the versions of the plugins they use and the drawing version. */
export const sampleHash = (s: Sample): string => hashJson({ thumb: THUMB_VERSION, id: s.id, base: s.base, steps: s.steps.map(st => ({ plugin: st.plugin, version: PLUGIN_VERSIONS[st.plugin] ?? '', op: st.op, params: st.params })) }).slice(0, 16)

/** The file name of a sample's picture, next to index.html. */
export const sampleImageUrl = (id: string): string => `samples/${id}.png`
