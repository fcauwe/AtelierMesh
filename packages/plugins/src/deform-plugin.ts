// Plugin `org.ateliermesh.deform`: smooth changes of shape (twist, taper, bend, wave, ripple) and smoothing of the surface itself (smooth). The code is in deform-run.ts and is loaded when the first step runs.
import type { Manifest, ParamDef, PluginEntry } from '@ateliermesh/core'

export const DEFORM_PLUGIN_ID = 'org.ateliermesh.deform'
export const DEFORM_PLUGIN_VERSION = '0.3.0'

const AXES = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]
const common = (): ParamDef[] => [
  { name: 'axis', type: 'enum', default: 'z', options: AXES, widget: 'segmented', section: 'axis' },
  { name: 'center', type: 'enum', default: 'bbox_center', options: [{ value: 'bbox_center', label: 'Centre of the box' }, { value: 'origin', label: 'Origin' }, { value: 'point', label: 'A point' }], section: 'axis' },
  { name: 'center_point', type: 'vector', size: 3, default: [0, 0, 0], unit: 'mm', widget: 'axes', visible_if: "center == 'point'", section: 'axis' },
  { name: 'from', type: 'float', default: 0, min: 0, max: 1, step: 0.01, widget: 'slider', help: 'Where along the axis the change starts (0 is the bottom, 1 the top).', section: 'range' },
  { name: 'to', type: 'float', default: 1, min: 0, max: 1, step: 0.01, widget: 'slider', section: 'range' },
  { name: 'detail', type: 'enum', default: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'fine', label: 'Fine' }, { value: 'coarse', label: 'Coarse' }], widget: 'segmented', section: 'detail' },
  { name: 'max_triangles', type: 'int', default: 1000000, min: 1000, max: 5000000, section: 'detail' },
]
const sections = [
  { id: 'shape', title: 'Shape' },
  { id: 'axis', title: 'Axis', collapsed: true },
  { id: 'range', title: 'Range', collapsed: true },
  { id: 'detail', title: 'Detail', collapsed: true },
]


const DETAIL4 = [{ value: 'auto', label: 'Automatic' }, { value: 'fine', label: 'Fine' }, { value: 'extra_fine', label: 'Extra fine' }, { value: 'coarse', label: 'Coarse' }]
const detailParams = (): ParamDef[] => [
  { name: 'detail', type: 'enum', default: 'auto', options: DETAIL4, widget: 'segmented', section: 'detail' },
  { name: 'max_triangles', type: 'int', default: 1000000, min: 1000, max: 5000000, section: 'detail' },
]
const centerParams = (): ParamDef[] => [
  { name: 'center', type: 'enum', default: 'bbox_center', options: [{ value: 'bbox_center', label: 'Centre of the box' }, { value: 'origin', label: 'Origin' }, { value: 'point', label: 'A point' }], section: 'axis' },
  { name: 'center_point', type: 'vector', size: 3, default: [0, 0, 0], unit: 'mm', widget: 'axes', visible_if: "center == 'point'", section: 'axis' },
]
const rangeParams = (): ParamDef[] => [
  { name: 'from', type: 'float', default: 0, min: 0, max: 1, step: 0.01, widget: 'slider', help: 'Where along the axis the change starts (0 is the bottom, 1 the top).', section: 'range' },
  { name: 'to', type: 'float', default: 1, min: 0, max: 1, step: 0.01, widget: 'slider', section: 'range' },
]
const WAVE_SECTIONS = [{ id: 'shape', title: 'Wave' }, { id: 'axis', title: 'Direction', collapsed: true }, { id: 'range', title: 'Range', collapsed: true }, { id: 'detail', title: 'Detail', collapsed: true }]
const RIPPLE_SECTIONS = [{ id: 'shape', title: 'Ripple' }, { id: 'axis', title: 'Centre', collapsed: true }, { id: 'detail', title: 'Detail', collapsed: true }]

export const deformManifest: Manifest = {
  manifest_version: 1,
  id: DEFORM_PLUGIN_ID,
  name: 'AtelierMesh deform',
  version: DEFORM_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  icon: 'spline',
  description: 'Twists, tapers, bends and waves a model, ripples a surface, and smooths it, always keeping a closed solid.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.deform.png', alt: 'A tall square pillar twisted a quarter turn.' },
  operations: [
    {
      id: 'twist', title: 'Twist', kind: 'modifier', category: 'shape', icon: 'twist', summary: '{{angle}}\u00b0', personalisable: 'optional', stages: ['deform'], sections,
      params: [
        { name: 'angle', type: 'float', default: 90, min: -1440, max: 1440, step: 5, unit: 'deg', widget: 'slider', importance: 'main', personalisable: true, section: 'shape' },
        { name: 'easing', type: 'enum', default: 'linear', options: [{ value: 'linear', label: 'Linear' }, { value: 'smooth', label: 'Smooth' }], widget: 'segmented', section: 'shape' },
        ...common(),
      ],
    },
    {
      id: 'taper', title: 'Taper', kind: 'modifier', category: 'shape', icon: 'taper', personalisable: 'optional', stages: ['deform'], sections,
      params: [
        { name: 'scale_end', type: 'float', default: 0.5, min: 0.05, max: 5, step: 0.05, widget: 'slider', importance: 'main', help: 'The size at the end of the range, as a fraction of the size at the start.', personalisable: true, section: 'shape' },
        { name: 'uniform', type: 'enum', default: 'both', options: [{ value: 'both', label: 'Both' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], widget: 'segmented', section: 'shape' },
        { name: 'easing', type: 'enum', default: 'linear', options: [{ value: 'linear', label: 'Linear' }, { value: 'smooth', label: 'Smooth' }], widget: 'segmented', section: 'shape' },
        ...common(),
      ],
    },
    {
      id: 'bend', title: 'Bend', kind: 'modifier', category: 'shape', icon: 'bend', summary: '{{angle}}\u00b0', personalisable: 'optional', stages: ['deform'], sections,
      params: [
        { name: 'angle', type: 'float', default: 45, min: -360, max: 360, step: 5, unit: 'deg', widget: 'slider', importance: 'main', help: 'How far the model is bent over the range. A negative angle bends the other way.', personalisable: true, section: 'shape' },
        { name: 'axis', type: 'enum', default: 'z', options: AXES, widget: 'segmented', help: 'The direction the model is long in: the bend runs along it.', section: 'axis' },
        { name: 'bend_axis', type: 'enum', default: 'x', options: AXES, widget: 'segmented', help: 'The direction the model folds towards. It must be a different axis.', section: 'axis' },
        ...centerParams(), ...rangeParams(), ...detailParams(),
      ],
    },
    {
      id: 'wave', title: 'Wave', kind: 'modifier', category: 'shape', icon: 'wave', summary: '{{amplitude}} mm @ {{wavelength}} mm', personalisable: 'optional', stages: ['deform'], sections: WAVE_SECTIONS,
      params: [
        { name: 'amplitude', type: 'float', default: 2, min: 0, max: 100, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', help: 'How far the surface moves up and down.', personalisable: true, section: 'shape' },
        { name: 'wavelength', type: 'float', default: 10, min: 0.5, max: 500, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', help: 'The distance from one crest to the next.', personalisable: true, section: 'shape' },
        { name: 'phase', type: 'float', default: 0, min: -360, max: 360, step: 15, unit: 'deg', help: 'Where in the wave the range starts.', section: 'shape' },
        { name: 'axis', type: 'enum', default: 'x', options: AXES, widget: 'segmented', help: 'The direction the wave travels along.', section: 'axis' },
        { name: 'direction', type: 'enum', default: 'z', options: [...AXES, { value: 'normal', label: 'Along the surface' }], widget: 'segmented', help: 'The direction the surface moves in. "Along the surface" follows the shape.', section: 'axis' },
        { name: 'falloff', type: 'float', default: 0, min: 0, max: 100, step: 0.5, unit: 'mm', help: 'The length over which the wave fades in and out at the ends of the range. 0 starts at full height.', section: 'range' },
        ...rangeParams(), ...detailParams(),
      ],
    },
    {
      id: 'ripple', title: 'Ripple', kind: 'modifier', category: 'shape', icon: 'ripple', summary: '{{amplitude}} mm @ {{wavelength}} mm', personalisable: 'optional', stages: ['deform'], sections: RIPPLE_SECTIONS,
      params: [
        { name: 'amplitude', type: 'float', default: 1.5, min: 0, max: 100, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', help: 'How far the surface moves up and down.', personalisable: true, section: 'shape' },
        { name: 'wavelength', type: 'float', default: 8, min: 0.5, max: 500, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', help: 'The distance from one ring to the next.', personalisable: true, section: 'shape' },
        { name: 'decay', type: 'float', default: 0, min: 0, max: 500, step: 1, unit: 'mm', help: 'How fast the rings fade away from the centre. 0 keeps them the same everywhere.', section: 'shape' },
        { name: 'radius', type: 'float', default: 0, min: 0, max: 1000, step: 1, unit: 'mm', help: 'The rings stop at this distance from the centre. 0 means no limit.', section: 'shape' },
        { name: 'phase', type: 'float', default: 90, min: -360, max: 360, step: 15, unit: 'deg', help: 'Where in the wave the centre starts. 90 starts with a smooth crest in the middle; 0 starts with a point.', section: 'shape' },
        { name: 'axis', type: 'enum', default: 'z', options: AXES, widget: 'segmented', help: 'The direction the surface moves in. The rings lie in the other two directions.', section: 'axis' },
        ...centerParams(), ...detailParams(),
      ],
    },
    {
      id: 'smooth', title: 'Smooth surface', kind: 'modifier', category: 'shape', icon: 'smooth', summary: '{{iterations}}\u00d7', personalisable: 'optional', stages: ['smooth'],
      sections: [{ id: 'shape', title: 'Smoothing' }, { id: 'part', title: 'Only a part', collapsed: true }, { id: 'advanced', title: 'Advanced', collapsed: true }],
      params: [
        { name: 'strength', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05, widget: 'slider', importance: 'main', help: 'How much each round smooths. 0 changes nothing.', personalisable: true, section: 'shape' },
        { name: 'iterations', type: 'int', default: 10, min: 1, max: 100, widget: 'slider', importance: 'main', help: 'How many rounds. More rounds smooth wider bumps.', section: 'shape' },
        { name: 'keep_edges', type: 'float', default: 40, min: 0, max: 180, step: 5, unit: 'deg', widget: 'slider', help: 'Edges where the surface turns by more than this angle stay crisp (smoothed along their length only). 180 smooths everything.', section: 'shape' },
        { name: 'part', type: 'part', kinds: ['segment', 'group'], default: '', allow_empty: true, help: 'Smooth only this part. Empty smooths the whole model.', section: 'part' },
        { name: 'falloff', type: 'float', default: 2, min: 0, max: 50, step: 0.5, unit: 'mm', visible_if: "part != ''", help: 'How far from the edge of the part the smoothing fades in.', section: 'part' },
        { name: 'keep_volume', type: 'bool', default: true, help: 'On: no shrinking (Taubin smoothing). Off: plain smoothing, which shrinks the model a little with every round.', section: 'advanced' },
        { name: 'keep_borders', type: 'bool', default: true, help: 'Keep the border of an open mesh where it is.', section: 'advanced' },
        { name: 'max_move', type: 'float', default: 0, min: 0, max: 50, step: 0.1, unit: 'mm', help: 'The most a point may move. 0 means no limit.', section: 'advanced' },
      ],
    },
  ],
}

export const deformPlugin = (): PluginEntry => ({ manifest: deformManifest, load: async () => (await import('./deform-run')).default })
