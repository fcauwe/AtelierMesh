// Plugin `org.ateliermesh.voronoi`: Voronoi patterns. `voronoi` is a pattern on the surface of a model; `voronoi_shell` hollows a closed model into a lattice. The code is in voronoi-run.ts and is loaded when the first
// step runs. The pattern is cut into the surface by the same engine as the text (unfold, imprint, lift), so it has the same modes and the same two parts.
import type { Manifest, PluginEntry } from '@ateliermesh/core'

export const VORONOI_PLUGIN_ID = 'org.ateliermesh.voronoi'
export const VORONOI_PLUGIN_VERSION = '0.2.3'

export const voronoiManifest: Manifest = {
  manifest_version: 1,
  id: VORONOI_PLUGIN_ID,
  name: 'AtelierMesh Voronoi pattern',
  version: VORONOI_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Draws a Voronoi pattern on a surface, or hollows a model into a Voronoi lattice shell.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.voronoi.png', alt: 'A tapered vase hollowed into a lattice of struts.' },
  operations: [
    {
      id: 'voronoi', title: 'Voronoi pattern', kind: 'modifier', category: 'surface', icon: 'voronoi', personalisable: 'optional',
      sections: [{ id: 'region', title: 'Area' }, { id: 'pattern', title: 'Pattern' }, { id: 'shape', title: 'Shape' }, { id: 'advanced', title: 'Advanced', collapsed: true }],
      stages: ['pattern', 'unfold', 'cut'],
      outputs: { mesh: true, report: true, segments: [{ param: 'segment' }, { param: 'walls_segment' }] },
      params: [
        { name: 'region', type: 'enum', default: 'rectangle', options: [{ value: 'rectangle', label: 'Rectangle' }, { value: 'circle', label: 'Circle' }], widget: 'segmented', importance: 'main', section: 'region' },
        { name: 'width', type: 'float', default: 40, min: 1, max: 400, unit: 'mm', importance: 'main', section: 'region', visible_if: "region == 'rectangle'" },
        { name: 'height_area', type: 'float', default: 30, min: 1, max: 400, unit: 'mm', importance: 'main', section: 'region', visible_if: "region == 'rectangle'" },
        { name: 'radius', type: 'float', default: 20, min: 0.5, max: 200, unit: 'mm', importance: 'main', section: 'region', visible_if: "region == 'circle'" },
        { name: 'margin', type: 'float', default: 1, min: 0, max: 50, unit: 'mm', section: 'region' },
        { name: 'cells', type: 'int', default: 40, min: 2, max: 2000, widget: 'stepper', importance: 'main', personalisable: true, section: 'pattern' },
        { name: 'seed', type: 'int', default: 1, min: 0, max: 999999, widget: 'stepper', importance: 'main', help: 'A different number gives a different pattern.', personalisable: true, section: 'pattern' },
        { name: 'irregularity', type: 'float', default: 0.6, min: 0, max: 1, step: 0.05, widget: 'slider', help: '0 gives even, honeycomb-like cells; 1 is random.', section: 'pattern' },
        { name: 'line_width', type: 'float', default: 1.2, min: 0.1, max: 20, unit: 'mm', section: 'pattern' },
        { name: 'fill', type: 'bool', default: false, section: 'pattern' },
        { name: 'rounding', type: 'float', default: 0, min: 0, max: 10, unit: 'mm', section: 'pattern' },
        { name: 'mode', type: 'enum', default: 'raised', options: [{ value: 'raised', label: 'Raised', icon: 'raised' }, { value: 'engraved', label: 'Engraved', icon: 'engraved' }, { value: 'flat', label: 'Flat (colour only)' }], widget: 'segmented', section: 'shape' },
        { name: 'height', type: 'float', default: 0.8, min: 0.1, max: 10, unit: 'mm', widget: 'slider', section: 'shape', visible_if: "mode != 'flat'" },
        { name: 'placement', type: 'placement', default: null, importance: 'main', personalisable: true, section: 'shape' },
        { name: 'segment', type: 'part', kinds: ['segment'], default: 'voronoi', allow_empty: true, section: 'advanced' },
        { name: 'walls_segment', type: 'part', kinds: ['segment'], default: 'voronoi_walls', allow_empty: true, section: 'advanced', visible_if: "mode != 'flat'" },
        { name: 'min_stroke', type: 'float', default: 0.6, min: 0, max: 10, unit: 'mm', section: 'advanced' },
        { name: 'min_wall', type: 'float', default: 0.4, min: 0, max: 10, unit: 'mm', section: 'advanced', visible_if: "mode == 'engraved'" },
      ],
    },
    {
      id: 'voronoi_shell', title: 'Voronoi shell', kind: 'modifier', category: 'style', icon: 'voronoi', summary: '{{cells}} cells', personalisable: 'optional',
      sections: [{ id: 'shell', title: 'Shell' }, { id: 'pattern', title: 'Pattern' }, { id: 'opening', title: 'Opening' }, { id: 'detail', title: 'Detail', collapsed: true }],
      stages: ['pattern', 'field', 'surface'],
      inputs: { mesh: { required: true } },
      outputs: { mesh: true, report: true, closed: true, drops: ['segments', 'groups'] },
      params: [
        { name: 'beam_rounding', type: 'float', default: 0, min: 0, max: 1, step: 0.05, widget: 'slider', importance: 'main', help: 'How round the struts are: 0 keeps square edges, 1 makes them round.', section: 'shell' },
        { name: 'thickness', type: 'float', default: 2, min: 0.4, max: 50, step: 0.1, unit: 'mm', widget: 'slider', importance: 'main', help: 'How deep the wall is, measured inward from the outside of the model.', section: 'shell' },
        { name: 'rib_width', type: 'float', default: 2, min: 0.6, max: 20, step: 0.1, unit: 'mm', widget: 'slider', importance: 'main', help: 'The width of the struts between the openings.', section: 'shell' },
        { name: 'smooth', type: 'float', default: 0.6, min: 0, max: 5, step: 0.1, unit: 'mm', widget: 'slider', help: 'Rounds the joints between the struts. 0 keeps them sharp. Used when the roundness of the struts is 0.', section: 'shell' },
        { name: 'cells', type: 'int', default: 60, min: 2, max: 1500, widget: 'stepper', importance: 'main', help: 'About how many openings the shell has. More cells make smaller openings.', personalisable: true, section: 'pattern' },
        { name: 'seed', type: 'int', default: 1, min: 0, max: 999999, widget: 'stepper', importance: 'main', help: 'A different number gives a different pattern.', personalisable: true, section: 'pattern' },
        { name: 'irregularity', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05, widget: 'slider', help: '0 gives even, honeycomb-like cells; 1 is random.', section: 'pattern' },
        { name: 'opening', type: 'enum', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }, { value: 'both', label: 'Both' }], widget: 'segmented', help: 'A round opening along the vertical (Z) axis through the top and/or the bottom.', section: 'opening' },
        { name: 'opening_diameter', type: 'float', default: 20, min: 1, max: 400, unit: 'mm', visible_if: "opening != 'none'", section: 'opening' },
        { name: 'detail', type: 'enum', default: 'fine', options: [{ value: 'auto', label: 'Automatic' }, { value: 'fine', label: 'Fine' }, { value: 'extra_fine', label: 'Extra fine' }, { value: 'coarse', label: 'Coarse' }], widget: 'segmented', section: 'detail' },
        { name: 'max_triangles', type: 'int', default: 600000, min: 1000, max: 5000000, section: 'detail' },
      ],
    },
  ],
}

export const voronoiPlugin = (): PluginEntry => ({ manifest: voronoiManifest, load: async () => (await import('./voronoi-run')).default })
