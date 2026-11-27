// Plugin `org.ateliermesh.repair`: repair a damaged mesh so it becomes a closed solid. The code is in repair-run.ts and is loaded when the first step runs.
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const REPAIR_PLUGIN_ID = 'org.ateliermesh.repair'
export const REPAIR_PLUGIN_VERSION = '0.1.0'

export const repairManifest: Manifest = {
  manifest_version: 1,
  id: REPAIR_PLUGIN_ID,
  name: 'AtelierMesh repair',
  version: REPAIR_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Closes holes, welds vertices, removes duplicate and degenerate triangles and floating pieces, and turns shells the right way out.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  operations: [
    {
      id: 'repair_mesh', title: 'Repair mesh', kind: 'modifier', category: 'prepare', icon: 'repair_mesh', personalisable: 'never', stages: ['weld', 'manifold', 'islands', 'holes'],
      sections: [{ id: 'fix', title: 'Repairs' }],
      params: [
        { name: 'weld', type: 'float', default: 0.001, min: 0, max: 10, step: 0.001, unit: 'mm', importance: 'main', help: 'Vertices closer than this are joined. 0 switches it off.', section: 'fix' },
        { name: 'non_manifold', type: 'enum', default: 'split', options: [{ value: 'split', label: 'Split' }, { value: 'remove', label: 'Remove' }, { value: 'off', label: 'Off' }], widget: 'segmented', importance: 'main', help: 'What to do with an edge shared by more than two triangles.', section: 'fix' },
        { name: 'fix_normals', type: 'bool', default: true, importance: 'main', section: 'fix' },
        { name: 'min_island', type: 'float', default: 1, min: 0, max: 50, step: 0.5, unit: '%', importance: 'advanced', help: 'Floating pieces smaller than this share of the largest piece are removed. 0 keeps them all.', section: 'fix' },
        { name: 'max_hole', type: 'int', default: 200, min: 0, max: 100000, importance: 'advanced', help: 'Holes with up to this many edges are closed. 0 switches it off.', section: 'fix' },
      ],
    },
  ],
}

export const repairPlugin = (): PluginEntry => ({ manifest: repairManifest, load: async () => (await import('./repair-run')).default })
