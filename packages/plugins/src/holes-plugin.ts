// Plugin `org.ateliermesh.holes`: cut a hole, a slot or a square pocket into a closed model at the place the user clicks. One operation, `cut_hole`.
// The code is in holes-run.ts and holes.ts and is loaded when the first step runs. The cut is an exact subtraction of a convex cutter: the model keeps every
// triangle the hole does not touch, bit for bit, and the result is always a closed solid.
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const HOLES_PLUGIN_ID = 'org.ateliermesh.holes'
export const HOLES_PLUGIN_VERSION = '0.1.0'

export const holesManifest: Manifest = {
  manifest_version: 1,
  id: HOLES_PLUGIN_ID,
  name: 'AtelierMesh holes',
  version: HOLES_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Cuts a round, slot or square hole, with an optional countersink or counterbore, where you click on the model.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.holes.png', alt: 'A name tag with a round hole near the end for a keyring.' },
  operations: [
    {
      id: 'cut_hole', title: 'Cut hole', kind: 'modifier', category: 'shape', icon: 'hole', summary: '{{shape}} {{diameter}} mm', personalisable: 'optional',
      sections: [{ id: 'hole', title: 'Hole' }, { id: 'edge', title: 'Edge', collapsed: true }, { id: 'more', title: 'More', collapsed: true }],
      stages: ['hole_cut', 'hole_wall'],
      inputs: { mesh: { required: true } },
      // closed in, closed out; every triangle the hole does not touch stays as it was
      outputs: { mesh: true, report: true, closed: true },
      params: [
        { name: 'placement', type: 'placement', default: null, personalisable: true, importance: 'main', section: 'hole' },
        { name: 'shape', type: 'enum', default: 'round', options: [{ value: 'round', label: 'Round', icon: 'hole_round' }, { value: 'slot', label: 'Slot', icon: 'hole_slot' }, { value: 'square', label: 'Square', icon: 'hole_square' }], widget: 'segmented', importance: 'main', section: 'hole' },
        { name: 'diameter', type: 'float', default: 5, min: 0.5, max: 100, step: 0.1, unit: 'mm', widget: 'slider', importance: 'main', personalisable: true, help: 'Round: the diameter. Slot and square: the width.', section: 'hole' },
        { name: 'length', type: 'float', default: 10, min: 1, max: 400, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', visible_if: "shape != 'round'", help: 'How long the slot or the square is.', section: 'hole' },
        { name: 'depth', type: 'float', default: 0, min: 0, max: 500, step: 0.5, unit: 'mm', importance: 'main', help: 'How deep the hole goes from the place you chose. 0 cuts all the way through.', section: 'hole' },
        { name: 'countersink', type: 'enum', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'countersink', label: 'Countersink' }, { value: 'counterbore', label: 'Counterbore' }], widget: 'segmented', help: 'A wider opening at the top, for a screw head: a cone (countersink) or a cylinder (counterbore).', section: 'edge' },
        { name: 'countersink_diameter', type: 'float', default: 10, min: 1, max: 200, step: 0.5, unit: 'mm', visible_if: "countersink != 'none'", help: 'The width of the wider opening at the surface.', section: 'edge' },
        { name: 'countersink_depth', type: 'float', default: 3, min: 0.2, max: 100, step: 0.5, unit: 'mm', visible_if: "countersink == 'counterbore'", help: 'How deep the wider part goes. A countersink is 90 degrees and takes the depth it needs.', section: 'edge' },
        { name: 'corner_radius', type: 'float', default: 0, min: 0, max: 50, step: 0.5, unit: 'mm', importance: 'advanced', visible_if: "shape == 'square'", help: 'How round the corners of the square are.', section: 'more' },
        { name: 'rotation', type: 'float', default: 0, min: -180, max: 180, step: 5, unit: 'deg', importance: 'advanced', visible_if: "shape != 'round'", help: 'Turns the slot or the square about its axis, on top of the direction of the place.', section: 'more' },
        { name: 'axis', type: 'enum', default: 'normal', options: [{ value: 'normal', label: 'Surface' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }], widget: 'segmented', importance: 'advanced', help: 'Which way the hole goes. Surface: straight into the surface at the place. X, Y or Z: along that axis, into the model.', section: 'more' },
        { name: 'min_wall', type: 'float', default: 0.8, min: 0.2, max: 10, step: 0.1, unit: 'mm', importance: 'advanced', help: 'The thinnest wall that may stay under the bottom of a blind hole. A thinner one gives a warning.', section: 'more' },
        { name: 'part', type: 'part', kinds: ['segment', 'group'], default: '', allow_empty: true, importance: 'advanced', help: 'Cut only through this part of the surface. Empty: the whole model.', section: 'more' },
      ],
    },
  ],
}

export const holesPlugin = (): PluginEntry => ({ manifest: holesManifest, load: async () => (await import('./holes-run')).default })
