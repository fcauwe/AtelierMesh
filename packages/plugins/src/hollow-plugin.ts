// Plugin `org.ateliermesh.hollow`: hollow a closed model to a wall of a given thickness. One operation, `hollow`. The code is in hollow-run.ts and is
// loaded when the first step runs. Without an opening the outside of the model is left exactly as it is and a cavity is added inside; with an opening the
// outside is made again (see hollow.ts).
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const HOLLOW_PLUGIN_ID = 'org.ateliermesh.hollow'
export const HOLLOW_PLUGIN_VERSION = '0.1.1'

export const hollowManifest: Manifest = {
  manifest_version: 1,
  id: HOLLOW_PLUGIN_ID,
  name: 'AtelierMesh hollow',
  version: HOLLOW_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Hollows a model to a wall thickness, keeping the outside exactly as it is, with an optional round opening.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.hollow.png', alt: 'A jar hollowed to a thin wall with a round opening in the top.' },
  operations: [
    {
      id: 'hollow', title: 'Hollow', kind: 'modifier', category: 'shape', icon: 'hollow', summary: '{{thickness}} mm', personalisable: 'never',
      sections: [{ id: 'wall', title: 'Wall' }, { id: 'opening', title: 'Opening' }, { id: 'detail', title: 'Detail', collapsed: true }],
      stages: ['field', 'surface', 'cavity'],
      inputs: { mesh: { required: true } },
      // the cavity gets a segment of its own (default `cavity`) so it can be told apart; with an opening the outside is made again and parts are not kept
      outputs: { mesh: true, report: true, closed: true, segments: [{ param: 'cavity_segment' }] },
      params: [
        { name: 'thickness', type: 'float', default: 2, min: 0.4, max: 50, step: 0.1, unit: 'mm', widget: 'slider', importance: 'main', help: 'How deep the wall is, measured inward from the outside of the model.', section: 'wall' },
        { name: 'smooth', type: 'float', default: 0.6, min: 0, max: 5, step: 0.1, unit: 'mm', widget: 'slider', help: 'How much the inside is smoothed. 0 keeps what the grid gives.', section: 'wall' },
        { name: 'opening', type: 'enum', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }, { value: 'both', label: 'Both' }], widget: 'segmented', importance: 'main', help: 'A round opening along the vertical (Z) axis through the top and/or the bottom, to drain, vent or fit something in. With an opening the outside of the model is made again.', section: 'opening' },
        { name: 'opening_diameter', type: 'float', default: 5, min: 1, max: 400, unit: 'mm', visible_if: "opening != 'none'", section: 'opening' },
        { name: 'detail', type: 'enum', default: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'fine', label: 'Fine' }, { value: 'coarse', label: 'Coarse' }], widget: 'segmented', section: 'detail' },
        { name: 'max_triangles', type: 'int', default: 600000, min: 1000, max: 5000000, section: 'detail' },
        { name: 'cavity_segment', type: 'part', kinds: ['segment'], default: 'cavity', allow_empty: true, importance: 'advanced', help: 'The name of the part given to the inside surface. Empty gives it no part of its own.', section: 'detail' },
      ],
    },
  ],
}

export const hollowPlugin = (): PluginEntry => ({ manifest: hollowManifest, load: async () => (await import('./hollow-run')).default })
