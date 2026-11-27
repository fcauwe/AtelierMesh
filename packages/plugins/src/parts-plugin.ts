// Plugin `org.ateliermesh.parts`: work on the parts of a mesh. First two operations: delete a part, or keep only one.
// A part is a segment (a labelled set of triangles of a surface) or a group (a distinct body). The code is in parts-run.ts and is loaded when the first step runs.
import type { Manifest, Operation, PluginEntry } from '@ateliermesh/core'

export const PARTS_PLUGIN_ID = 'org.ateliermesh.parts'
export const PARTS_PLUGIN_VERSION = '0.1.0'

const params = (): Operation['params'] => [
  { name: 'part', type: 'part', kinds: ['group', 'segment'], default: '', preselect: 'first', importance: 'main' },
  { name: 'close_hole', type: 'enum', default: 'fill', options: ['fill', 'none'], widget: 'segmented' },
  { name: 'remove_unused', type: 'bool', default: true, section: 'advanced' },
]

export const partsManifest: Manifest = {
  manifest_version: 1,
  id: PARTS_PLUGIN_ID,
  name: 'AtelierMesh parts',
  version: PARTS_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Deletes a part of a model (a body or a coloured region), or keeps only one part.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  operations: [
    {
      id: 'delete_part', title: 'Delete part', kind: 'modifier', summary: '{{part}}', category: 'prepare', personalisable: 'never', stages: ['parts', 'holes'],
      sections: [{ id: 'advanced', title: 'Advanced', collapsed: true }],
      // the part named by `part` is gone afterwards: a later step that names it gets the `part.dropped` warning
      outputs: { mesh: true, report: true, drops: [{ param: 'part' }] },
      params: params(),
    },
    {
      id: 'keep_part', title: 'Keep only part', kind: 'modifier', summary: '{{part}}', category: 'prepare', personalisable: 'never', stages: ['parts', 'holes'],
      sections: [{ id: 'advanced', title: 'Advanced', collapsed: true }],
      // every other part of that kind is gone
      outputs: { mesh: true, report: true, drops: [{ param: 'part', keep: true }] },
      params: params(),
    },
  ],
}

export const partsPlugin = (): PluginEntry => ({ manifest: partsManifest, load: async () => (await import('./parts-run')).default })
