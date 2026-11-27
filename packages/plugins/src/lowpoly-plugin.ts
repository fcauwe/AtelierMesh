// Plugin `org.ateliermesh.lowpoly`: an artistic low-poly version of the model. The code is in lowpoly-run.ts and is loaded when the first step runs.
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const LOWPOLY_PLUGIN_ID = 'org.ateliermesh.lowpoly'
export const LOWPOLY_PLUGIN_VERSION = '0.3.0'

export const lowpolyManifest: Manifest = {
  manifest_version: 1,
  id: LOWPOLY_PLUGIN_ID,
  name: 'AtelierMesh low poly',
  version: LOWPOLY_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Rebuilds a model as an artistic low-poly version: either a few large flat facets that follow the shape, or a mosaic of even facets with a random in-and-out jitter and optional facet colours.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.lowpoly.png', alt: 'A sphere reduced to a few hundred flat triangles.' },
  operations: [
    {
      id: 'low_poly', title: 'Low poly', kind: 'modifier', category: 'style', icon: 'low_poly', personalisable: 'never', stages: ['collapse', 'crystallise', 'remesh', 'facets', 'check'],
      outputs: { mesh: true, report: true, closed: true, segments: ['facet_1', 'facet_2', 'facet_3', 'facet_4'] },
      limits: { max_output_triangles: 2000000 },
      sections: [{ id: 'detail', title: 'Detail' }, { id: 'look', title: 'Look' }, { id: 'facets', title: 'Facets' }, { id: 'shape', title: 'Shape' }, { id: 'colours', title: 'Colours' }],
      params: [
        // `style`: reduce = few large facets (the original step); facets = a mosaic of even facets with jitter (src/facets/facets.ts, docs/facets-method.md)
        { name: 'style', type: 'enum', default: 'reduce', options: [{ value: 'reduce', label: 'Reduce' }, { value: 'facets', label: 'Even facets' }], widget: 'segmented', importance: 'main' },
        // `triangles_mode`: automatic finds the smallest count that stays within a tolerance derived from `detail`; fixed uses `triangles`
        { name: 'triangles_mode', type: 'enum', default: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'fixed', label: 'Fixed number' }], widget: 'segmented', importance: 'main', section: 'detail', visible_if: "style == 'reduce'" },
        { name: 'detail', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05, widget: 'slider', importance: 'main', help: '0 is very coarse and artistic, 1 stays close to the original.', section: 'detail', visible_if: "style == 'reduce' && triangles_mode == 'auto'" },
        { name: 'triangles', type: 'int', default: 2000, min: 12, max: 200000, importance: 'main', section: 'detail', visible_if: "style == 'reduce' && triangles_mode == 'fixed'" },
        { name: 'sharpness', type: 'float', default: 40, min: 1, max: 90, unit: 'deg', widget: 'slider', help: 'Edges sharper than this stay crisp.', section: 'look', visible_if: "style == 'reduce'" },
        { name: 'crystallise', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05, widget: 'slider', section: 'look', visible_if: "style == 'reduce'" },
        { name: 'keep_borders', type: 'bool', default: true, section: 'look', visible_if: "style == 'reduce'" },
        { name: 'facet_size', type: 'float', default: 15, min: 4, max: 40, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', section: 'facets', visible_if: "style == 'facets'" },
        { name: 'jitter', type: 'float', default: 1.2, min: 0, max: 3, step: 0.1, unit: 'mm', widget: 'slider', importance: 'main', section: 'facets', visible_if: "style == 'facets'" },
        { name: 'shift', type: 'float', default: 10, min: 0, max: 30, step: 1, unit: '%', widget: 'slider', importance: 'normal', section: 'facets', visible_if: "style == 'facets'" },
        { name: 'seed', type: 'int', default: 1, min: 0, max: 999999, step: 1, importance: 'normal', section: 'facets', visible_if: "style == 'facets'" },
        { name: 'inside', type: 'enum', default: 'follow', options: [{ value: 'follow', label: 'Follow' }, { value: 'smooth', label: 'Smooth' }], widget: 'segmented', importance: 'normal', section: 'shape', visible_if: "style == 'facets'" },
        { name: 'wall', type: 'float', default: 1.6, min: 0.8, max: 6, step: 0.1, unit: 'mm', widget: 'slider', importance: 'normal', section: 'shape', visible_if: "style == 'facets'" },
        { name: 'plain_bottom', type: 'float', default: 0, min: 0, max: 500, step: 1, unit: 'mm', importance: 'normal', section: 'shape', visible_if: "style == 'facets'" },
        { name: 'plain_top', type: 'float', default: 0, min: 0, max: 500, step: 1, unit: 'mm', importance: 'normal', section: 'shape', visible_if: "style == 'facets'" },
        { name: 'facet_colours', type: 'enum', default: 'one', options: [{ value: 'one', label: 'One' }, { value: 'alternating', label: 'Alternating' }, { value: 'random', label: 'Random' }], widget: 'segmented', importance: 'main', section: 'colours', visible_if: "style == 'facets'" },
        { name: 'palette_size', type: 'int', default: 3, min: 2, max: 4, step: 1, importance: 'normal', section: 'colours', visible_if: "style == 'facets' && facet_colours == 'random'" },
        { name: 'colour_1', type: 'color', default: '#e9dcc9', importance: 'normal', section: 'colours', visible_if: "style == 'facets'" },
        { name: 'colour_2', type: 'color', default: '#c8553d', importance: 'normal', section: 'colours', visible_if: "style == 'facets' && facet_colours != 'one'" },
        { name: 'colour_3', type: 'color', default: '#2f4858', importance: 'normal', section: 'colours', visible_if: "style == 'facets' && facet_colours == 'random' && palette_size > 2" },
        { name: 'colour_4', type: 'color', default: '#f6ae2d', importance: 'normal', section: 'colours', visible_if: "style == 'facets' && facet_colours == 'random' && palette_size > 3" },
      ],
    },
  ],
}

export const lowpolyPlugin = (): PluginEntry => ({ manifest: lowpolyManifest, load: async () => (await import('./lowpoly-run')).default })
