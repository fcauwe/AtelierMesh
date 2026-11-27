// Plugin `org.ateliermesh.core`: the manifest of the built-in operations. The code is in core-run.ts and is loaded when the first step runs,
// so a page that only needs the manifests (the step list, the panel) does not carry fontkit, clipper or the WebAssembly decimator.
import type { Manifest, ParamDef, PluginEntry } from '@ateliermesh/core'

export const CORE_PLUGIN_ID = 'org.ateliermesh.core'
export const CORE_PLUGIN_VERSION = '0.4.0'

const PIVOTS = [
  { value: 'bbox_center', label: 'Centre of the box' }, { value: 'bbox_bottom_center', label: 'Centre of the bottom' }, { value: 'origin', label: 'Origin' },
  { value: 'centroid', label: 'Centre of mass' }, { value: 'point', label: 'A point' },
]
const pivotParams: ParamDef[] = [
  { name: 'pivot', type: 'enum', default: 'bbox_center', options: PIVOTS, section: 'pivot' },
  { name: 'pivot_point', type: 'vector', size: 3, default: [0, 0, 0], unit: 'mm', widget: 'axes', visible_if: "pivot == 'point'", section: 'pivot' },
]


/** The two "on the surface" operations share one engine and the same shape, placement, segment and check settings. */
function embossOp(id: string, title: string, own: ParamDef[]): Manifest['operations'][number] {
  return {
    id, title, kind: 'modifier', category: 'surface', icon: id, ...(id === 'emboss' ? { summary: '\u201c{{text}}\u201d' } : {}), personalisable: 'optional',
    sections: [{ id: 'main', title: id === 'emboss' ? 'Text, size and place' : 'Drawing, size and place' }, { id: 'text', title: id === 'emboss' ? 'Font and layout' : 'Drawing options', collapsed: true }, { id: 'shape', title: 'Shape', collapsed: true }, { id: 'advanced', title: 'Advanced', collapsed: true }],
    stages: ['text', 'unfold', 'cut'],
    outputs: { mesh: true, report: true, segments: [{ param: 'segment' }, { param: 'walls_segment' }] },
    params: [
      ...own,
      { name: 'max_width', type: 'float', default: 0, min: 0, max: 2000, unit: 'mm', section: 'text', help: '0 keeps the text on one line.' },
      { name: 'mode', type: 'enum', default: 'raised', options: [{ value: 'raised', label: 'Raised', icon: 'raised' }, { value: 'engraved', label: 'Engraved', icon: 'engraved' }, { value: 'flat', label: 'Flat (colour only)' }], widget: 'segmented', section: 'shape' },
      { name: 'height', type: 'float', default: 0.8, min: 0.1, max: 10, unit: 'mm', widget: 'slider', section: 'shape', visible_if: "mode != 'flat'" },
      { name: 'placement', type: 'placement', default: null, personalisable: true, section: 'main' },
      { name: 'segment', type: 'part', kinds: ['segment'], default: 'text', allow_empty: true, section: 'advanced' },
      { name: 'walls_segment', type: 'part', kinds: ['segment'], default: 'text_walls', allow_empty: true, section: 'advanced', visible_if: "mode != 'flat'" },
      { name: 'min_stroke', type: 'float', default: 0.6, min: 0, max: 10, unit: 'mm', section: 'advanced' },
      { name: 'min_wall', type: 'float', default: 0.4, min: 0, max: 10, unit: 'mm', section: 'advanced', visible_if: "mode == 'engraved'" },
    ],
  }
}

export const coreManifest: Manifest = {
  manifest_version: 1,
  id: CORE_PLUGIN_ID,
  name: 'AtelierMesh core operations',
  version: CORE_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Resize, rotate, orient for printing, text and SVG on the surface, triangle reduction, and the overhang and orientation checks.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.core.png', alt: 'A flat name tag with the name Anna raised on its top face.' },
  operations: [
    {
      id: 'resize', title: 'Resize', kind: 'modifier', category: 'shape', icon: 'resize', personalisable: 'optional',
      sections: [{ id: 'pivot', title: 'Pivot', collapsed: true }],
      params: [
        { name: 'mode', type: 'enum', default: 'percent', options: [{ value: 'percent', label: 'Percent' }, { value: 'target_size', label: 'Target size' }, { value: 'per_axis', label: 'Per direction' }], widget: 'segmented', importance: 'main', personalisable: true },
        { name: 'percent', type: 'float', default: 100, min: 1, max: 10000, unit: '%', scale: 'log', importance: 'main', personalisable: true, visible_if: "mode == 'percent'" },
        { name: 'target_axis', type: 'enum', default: 'x', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }], widget: 'segmented', importance: 'main', personalisable: true, visible_if: "mode == 'target_size'" },
        { name: 'target_mm', type: 'float', default: 50, min: 0.1, max: 2000, unit: 'mm', importance: 'main', personalisable: true, visible_if: "mode == 'target_size'" },
        { name: 'keep_proportions', type: 'bool', default: true, importance: 'main', personalisable: true, help: 'On: the other directions follow. Off: only the chosen direction changes (a stretch).', visible_if: "mode == 'target_size'" },
        { name: 'percent_x', type: 'float', default: 100, min: 1, max: 10000, unit: '%', scale: 'log', importance: 'main', personalisable: true, help: 'Size along X.', visible_if: "mode == 'per_axis'" },
        { name: 'percent_y', type: 'float', default: 100, min: 1, max: 10000, unit: '%', scale: 'log', importance: 'main', personalisable: true, help: 'Size along Y.', visible_if: "mode == 'per_axis'" },
        { name: 'percent_z', type: 'float', default: 100, min: 1, max: 10000, unit: '%', scale: 'log', importance: 'main', personalisable: true, help: 'Size along Z.', visible_if: "mode == 'per_axis'" },
        ...pivotParams,
      ],
    },
    {
      id: 'rotate', title: 'Rotate', kind: 'modifier', category: 'shape', icon: 'rotate', personalisable: 'optional',
      sections: [{ id: 'pivot', title: 'Pivot', collapsed: true }],
      params: [
        { name: 'angles', type: 'vector', size: 3, default: [0, 0, 0], min: -360, max: 360, unit: 'deg', labels: ['x', 'y', 'z'], widget: 'axes', importance: 'main', personalisable: true },
        { name: 'order', type: 'enum', default: 'XYZ', options: ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'], importance: 'advanced', help: 'The order in which the three turns are applied.' },
        { name: 'snap_step', type: 'float', default: 0, min: 0, max: 180, unit: 'deg', importance: 'advanced', help: '0 turns freely; otherwise the angles snap to multiples of this.' },
        ...pivotParams,
      ],
    },
    embossOp('emboss', 'Text on the surface', [
      // `source` is the old switch between text and SVG, kept so a stored step still validates; it is ignored (and hidden) now
      { name: 'source', type: 'enum', default: 'text', options: ['text', 'svg'], section: 'text', visible_if: "mode == 'legacy'" },
      { name: 'text', type: 'string', default: 'Text', max_length: 200, multiline: true, personalisable: true, section: 'main' },
      { name: 'font', type: 'asset', default: null, accept: ['font'], library: 'fonts', widget: 'font', preview: 'text', personalisable: true, section: 'text' },
      { name: 'weight', type: 'int', default: 400, min: 100, max: 900, step: 100, widget: 'stepper', section: 'text' },
      { name: 'size', type: 'float', default: 8, min: 1, max: 200, unit: 'mm', widget: 'slider', personalisable: true, section: 'main' },
      { name: 'align', type: 'enum', default: 'center', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], widget: 'segmented', section: 'text' },
      { name: 'spacing', type: 'float', default: 0, min: -2, max: 20, unit: 'mm', section: 'text' },
      { name: 'line_spacing', type: 'float', default: 1.2, min: 0.8, max: 3, section: 'text' },
    ]),
    embossOp('emboss_svg', 'SVG on the surface', [
      // a drawing kept in the project store (import an SVG with `svgToDrawing`); closed paths are filled, open paths are left out
      { name: 'shape', type: 'payload', accept: ['drawing'], default: null, personalisable: true, section: 'main' },
      { name: 'size', type: 'float', default: 8, min: 1, max: 200, unit: 'mm', widget: 'slider', personalisable: true, section: 'main' },
    ]),
    {
      id: 'decimate', title: 'Reduce triangles', kind: 'modifier', category: 'shape', icon: 'decimate', personalisable: 'never', stages: ['collapse'],
      params: [
        { name: 'mode', type: 'enum', default: 'quality', options: [{ value: 'quality', label: 'As small as possible' }, { value: 'target', label: 'Target number' }], widget: 'segmented', importance: 'main', help: 'Either remove every triangle that does not change the shape by more than the quality asks, or reduce to a number of triangles you choose.' },
        { name: 'tolerance', type: 'float', default: 0.05, min: 0.001, max: 100, step: 0.01, unit: 'mm', importance: 'main', visible_if: "mode == 'quality'", help: 'How far the surface may move. A smaller number keeps more triangles and more detail.' },
        { name: 'target_triangles', type: 'int', default: 50000, min: 4, max: 5000000, importance: 'main', visible_if: "mode == 'target'" },
        { name: 'max_error', type: 'float', default: 0, min: 0, max: 100, unit: 'mm', importance: 'advanced', visible_if: "mode == 'target'", help: '0 means no limit on how far the surface may move.' },
        { name: 'preserve_boundary', type: 'bool', default: true, importance: 'advanced' },
        { name: 'preserve_creases', type: 'bool', default: true, importance: 'advanced' },
        { name: 'crease_angle', type: 'float', default: 40, min: 1, max: 179, unit: 'deg', importance: 'advanced', visible_if: 'preserve_creases' },
        { name: 'engine', type: 'enum', default: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'wasm', label: 'WebAssembly' }, { value: 'js', label: 'JavaScript' }], widget: 'segmented', importance: 'advanced' },
      ],
    },
    {
      id: 'overhang', title: 'Overhang check', kind: 'analyzer', category: 'check', icon: 'overhang', importance: 'low', summary: '{{angle}}\u00b0', outputs: { mesh: false, report: true },
      params: [{ name: 'angle', type: 'float', default: 45, min: 1, max: 89, unit: 'deg', widget: 'slider', importance: 'main' }],
    },
    {
      id: 'auto_orient', title: 'Best orientation', kind: 'analyzer', category: 'check', icon: 'auto_orient', importance: 'low', outputs: { mesh: false, report: true },
      params: [
        { name: 'goal', type: 'enum', default: 'min_support', options: [{ value: 'min_support', label: 'Least support' }, { value: 'min_height', label: 'Lowest height' }, { value: 'max_stability', label: 'Most stable' }], widget: 'cards', importance: 'main' },
        { name: 'candidates', type: 'int', default: 12, min: 6, max: 24, importance: 'advanced', help: 'How many orientations are tried.' },
        { name: 'overhang_angle', type: 'float', default: 45, min: 1, max: 89, unit: 'deg', importance: 'advanced' },
      ],
    },
    {
      // the same search as the analyzer above, but the model is turned the best way up and put on the bed
      id: 'orient', title: 'Orient for printing', kind: 'modifier', category: 'prepare', icon: 'auto_orient', personalisable: 'never', stages: ['auto_orient'],
      outputs: { mesh: true, report: true, closed: true },
      params: [
        { name: 'goal', type: 'enum', default: 'min_support', options: [{ value: 'min_support', label: 'Least support' }, { value: 'min_height', label: 'Lowest height' }, { value: 'max_stability', label: 'Most stable' }], widget: 'cards', importance: 'main' },
        { name: 'place_on_bed', type: 'bool', default: true, importance: 'main', help: 'Move the model down so its lowest point is on the bed (Z = 0).' },
        { name: 'candidates', type: 'int', default: 12, min: 6, max: 24, importance: 'advanced', help: 'How many orientations are tried.' },
        { name: 'overhang_angle', type: 'float', default: 45, min: 1, max: 89, unit: 'deg', importance: 'advanced' },
      ],
    },
  ],
}

export const corePlugin = (): PluginEntry => ({ manifest: coreManifest, load: async () => (await import('./core-run')).default })
