// Plugin `org.ateliermesh.printcheck`: a report on what could go wrong when the model is printed. One operation, `printability`, an analyzer: it never
// changes the mesh. The code is in printcheck-run.ts and is loaded when the first step runs; the checks are in printcheck.ts.
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const PRINTCHECK_PLUGIN_ID = 'org.ateliermesh.printcheck'
export const PRINTCHECK_PLUGIN_VERSION = '0.1.0'

export const printcheckManifest: Manifest = {
  manifest_version: 1,
  id: PRINTCHECK_PLUGIN_ID,
  name: 'AtelierMesh print check',
  version: PRINTCHECK_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Reports what could go wrong when printing a model: parts that start in mid-air (floating bodies and islands), overhangs and bridges that need support, thin walls, gaps and size, with a score and advice.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  operations: [
    {
      id: 'printability', title: 'Printability check', kind: 'analyzer', category: 'check', icon: 'printability', importance: 'low', personalisable: 'never',
      sections: [{ id: 'printer', title: 'Printer' }, { id: 'limits', title: 'Limits', collapsed: true }],
      stages: ['printcheck'],
      inputs: { mesh: { required: true } },
      outputs: { mesh: false, report: true },
      params: [
        { name: 'process', type: 'enum', default: 'fdm', options: [{ value: 'fdm', label: 'FDM (filament)' }, { value: 'resin', label: 'Resin' }], widget: 'segmented', importance: 'main', help: 'The kind of printer: it sets the smallest wall, detail and gap that print well.', section: 'printer' },
        { name: 'nozzle', type: 'float', default: 0.4, min: 0.1, max: 1.5, step: 0.05, unit: 'mm', widget: 'slider', importance: 'main', visible_if: "process == 'fdm'", help: 'The width of the line the nozzle lays down.', section: 'printer' },
        { name: 'layer_height', type: 'float', default: 0.2, min: 0.02, max: 0.6, step: 0.01, unit: 'mm', visible_if: "process == 'fdm'", help: 'Details thinner than four layers do not come out.', section: 'printer' },
        { name: 'bed', type: 'vector', size: 3, default: [220, 220, 250], min: 0, max: 2000, unit: 'mm', labels: ['x', 'y', 'z'], widget: 'axes', importance: 'main', help: 'The build volume. Use 0 on an axis to leave it out.', section: 'printer' },
        { name: 'min_wall', type: 'float', default: 0, min: 0, max: 10, step: 0.1, unit: 'mm', help: 'The thinnest wall that prints. 0 chooses it from the printer (twice the nozzle; 0.6 mm for resin).', section: 'limits' },
        { name: 'min_feature', type: 'float', default: 0, min: 0, max: 10, step: 0.1, unit: 'mm', help: 'The thinnest post, pin or spike. 0 chooses it from the printer.', section: 'limits' },
        { name: 'min_gap', type: 'float', default: 0, min: 0, max: 10, step: 0.05, unit: 'mm', help: 'The narrowest gap that stays open. 0 chooses it from the printer.', section: 'limits' },
        { name: 'overhang_angle', type: 'float', default: 45, min: 1, max: 89, unit: 'deg', help: 'Faces that lean over more than this (measured from straight down) need support.', section: 'limits' },
        { name: 'bridge_length', type: 'float', default: 10, min: 1, max: 100, unit: 'mm', help: 'The longest flat roof that prints without support.', section: 'limits' },
        { name: 'min_overhang_area', type: 'float', default: 20, min: 0, max: 10000, step: 1, unit: 'mm²', help: 'A sloped overhang smaller than this is left out of the advice to add support.', section: 'limits' },
      ],
    },
  ],
}

export const printcheckPlugin = (): PluginEntry => ({ manifest: printcheckManifest, load: async () => (await import('./printcheck-run')).default })
