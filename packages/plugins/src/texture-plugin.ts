// Plugin `org.ateliermesh.texture`: surface textures (bump patterns) for printing. One operation, `texture`. The code is in texture-run.ts and is
// loaded when the first step runs. A clean implementation from first principles (see texture.ts); no code or pictures of other tools are used.
import type { Manifest, ParamDef, PluginEntry } from '@ateliermesh/core'

export const TEXTURE_PLUGIN_ID = 'org.ateliermesh.texture'
export const TEXTURE_PLUGIN_VERSION = '0.1.3'

const opt = (value: string, label: string): { value: string; label: string } => ({ value, label })
/**
 * A choice with a small picture of its own (`shape`: an SVG path on a 24 x 24 grid), so the pattern is chosen by looking at it. The pictures are solid silhouettes of the
 * raised part of each pattern, cut from the pattern's own height function (a few tiles, the height over a threshold, outlines simplified), so a card shows what the surface gets.
 */
const pic = (value: string, label: string, shape: string): { value: string; label: string; shape: string } => ({ value, label, shape })
const SHAPES: Record<string, string> = {
  "knurl": "M5.7 3.1 9.9 3.1 7.7 5.4zM14.7 3.1 18.9 3.1 16.6 5.4zM3.3 5.5 5.4 7.7 3.1 9.9zM12.3 5.5 14.4 7.7 12.1 9.9 9.9 7.7zM21.2 5.5 21.1 9.9 18.9 7.7zM7.8 10.1 9.9 12.1 7.7 14.4 5.4 12.1zM16.8 10.1 18.9 12.1 16.6 14.4 14.4 12.1zM3.3 14.6 5.4 16.6 3.1 18.9zM12.3 14.6 14.4 16.6 12.1 18.9 9.9 16.6zM21.2 14.6 21.1 18.9 18.9 16.6zM7.8 19.1 9.9 21.1 5.4 21.1zM16.8 19.1 18.9 21.1 14.4 21.1z",
  "ridges": "M3.9 3.1 7.1 3.1 7 21.2 3.7 21.1zM8.4 3.1 11.6 3.1 11.5 21.2 8.2 21.1zM12.9 3.1 16.1 3.1 16 21.2 12.7 21.1zM17.4 3.1 20.6 3.1 20.6 21.2 17.2 21.1z",
  "waves": "M3 5q3-3 6 0t6 0 6 0v3.5q-3-3-6 0t-6 0-6 0zM3 11.5q3-3 6 0t6 0 6 0v3.5q-3-3-6 0t-6 0-6 0zM3 18q3-3 6 0t6 0 6 0v3.5q-3-3-6 0t-6 0-6 0z",
  "dots": "M5.8 4.2 7.3 4.5 8.1 5.7 8 7 6.6 8.1 5.3 8 4.2 6.6 4.5 5zM11.8 4.2 13.3 4.5 14.1 5.7 14 7 12.6 8.1 11.3 8 10.2 6.6 10.5 5zM17.9 4.2 19.3 4.5 20.1 5.7 20 7 18.6 8.1 17.3 8 16.2 6.6 16.5 5zM5.8 10.2 7.3 10.5 8.1 11.7 8 13.1 6.6 14.1 5.3 14 4.2 12.6 4.5 11zM11.8 10.2 13.3 10.5 14.1 11.7 14 13.1 12.6 14.1 11.3 14 10.2 12.6 10.5 11zM17.9 10.2 19.3 10.5 20.1 11.7 20 13.1 18.6 14.1 17.3 14 16.2 12.6 16.5 11zM5.8 16.2 7.3 16.5 8.1 17.7 8 19.1 6.6 20.1 5.3 20 4.2 18.6 4.5 17zM11.8 16.2 13.3 16.5 14.1 17.7 14 19.1 12.6 20.1 11.3 20 10.2 18.6 10.5 17zM17.9 16.2 19.3 16.5 20.1 17.7 20 19.1 18.6 20.1 17.3 20 16.2 18.6 16.5 17z",
  "hex_dots": "M3.3 3.1 5.3 3.3 4.7 4.7 3.1 5.3zM7.2 3.1 11.3 3.3 10.5 4.8 9 5.3 7.5 4.5zM13.2 3.1 17.3 3.3 16.5 4.8 15 5.3 13.5 4.5zM19.2 3.1 21.2 3.1 21.1 5.3 19.5 4.5zM5.7 6.3 7.3 6.6 8.3 8 8 9.4 6.9 10.4 5.1 10.2 4 8.8 4.3 7.2zM11.7 6.3 13.3 6.6 14.3 8 14 9.4 12.9 10.4 11.1 10.2 10.1 8.8 10.3 7.2zM17.7 6.3 19.4 6.6 20.3 8 20 9.4 18.9 10.4 17.1 10.2 16 8.8 16.3 7.2zM3.2 11.4 4.7 12 5.3 13.7 4.5 15.2 3.1 15.7zM9.2 11.4 7.7 12 7 13.3 7.5 14.8 8.9 15.7 10.3 15.3 11.3 13.8 10.8 12.1zM15.2 11.4 13.7 12 13 13.3 13.5 14.8 14.8 15.7 16.4 15.3 17.3 13.8 16.8 12.1zM21.1 11.4 19.7 12 19 13.3 19.5 14.8 20.9 15.7zM5.8 16.6 7.5 17.1 8.3 18.4 7.8 20.1 6.5 20.9 4.8 20.4 4 19.1 4.5 17.4zM11.8 16.6 13.5 17.1 14.3 18.4 13.8 20.1 12.5 20.9 10.8 20.4 10 19.1 10.5 17.4zM17.9 16.6 19.5 17.1 20.3 18.4 19.8 20.1 18.4 20.9 16.8 20.4 16 19.1 16.5 17.4z",
  "hexagons": "M3.3 3.1 7.1 3.1 7.1 5.4 3.1 7.7zM8.4 3.1 16.1 3.1 16.1 5.4 12.1 7.7 8.2 5.4zM17.4 3.1 21.2 3.1 21.1 7.7 17.2 5.4zM7.7 6.5 11.6 8.7 11.6 13.1 7.7 15.5 3.7 13.2 3.7 8.7zM16.7 6.5 20.6 8.7 20.6 13.1 16.6 15.5 12.7 13.2 12.7 8.7zM3.2 14.3 7.1 16.5 6.8 21.1 3.1 21.1zM12.2 14.3 16.1 16.5 16.1 21 8.5 21.1 8.2 16.5zM21.2 14.3 21.2 21.1 17.5 21.1 17.2 16.5z",
  "bricks": "M4 3.8 11.4 3.8 11.5 6.9 3.9 7zM13.1 3.8 20.4 3.8 20.5 6.9 12.9 7zM3.3 8.3 6.9 8.3 7 11.4 3.1 11.5zM8.6 8.3 15.9 8.3 16 11.4 8.4 11.5zM17.6 8.3 21.1 8.3 21.1 11.5 17.4 11.5zM4 12.8 11.4 12.8 11.5 15.9 3.9 16zM13.1 12.8 20.4 12.8 20.5 15.9 12.9 16zM3.3 17.3 6.9 17.3 7 20.4 3.1 20.5zM8.6 17.3 15.9 17.3 16 20.4 8.4 20.5zM17.6 17.3 21.1 17.3 21.1 20.5 17.4 20.5z",
  "weave": "M8.3 3.1 11.7 3.1 11.7 7.5 8.1 7.5zM17.3 3.1 20.7 3.1 20.7 7.5 17.1 7.5zM3.3 3.6 7.5 3.6 7.5 7.2 3.1 7.2zM12.3 3.6 16.5 3.6 16.5 7.2 12.1 7.2zM3.8 7.6 7.2 7.7 7.2 12 3.6 12zM12.8 7.6 16.2 7.7 16.2 12 12.6 12zM7.8 8.1 12 8.1 12 11.7 7.7 11.7zM16.8 8.1 21 8.1 21 11.7 16.6 11.7zM8.3 12.1 11.7 12.1 11.7 16.5 8.1 16.5zM17.3 12.1 20.7 12.1 20.7 16.5 17.1 16.5zM3.3 12.6 7.5 12.6 7.5 16.2 3.1 16.2zM12.3 12.6 16.5 12.6 16.5 16.2 12.1 16.2zM3.8 16.6 7.2 16.6 7.2 21 3.6 21zM12.8 16.6 16.2 16.6 16.2 21 12.6 21zM7.8 17.1 12 17.1 12 20.7 7.7 20.7zM16.8 17.1 21 17.1 21 20.7 16.6 20.7z",
  "grid": "M3.3 3.1 21.2 3.1 21.1 21.2 3.1 21.1zM4 4 4 11.3 11.3 11.3 11.3 4zM13.1 4 13 11.3 20.3 11.3 20.3 4zM4 13 4 20.3 11.3 20.3 11.3 13.1zM13.1 13 13 20.3 20.3 20.3 20.3 13.1z",
  "noise": "M5.3 3.1 10.7 3.1 9.1 4.2 10.1 6.8 8.1 8.3 5.2 8.6 4.3 9.6 5.3 11.4 6.3 11.9 7.2 11.7 7.7 10.8 8.7 10.8 7.7 12.1 7.8 14.6 8.9 15.6 10.7 15.8 9.1 17.3 10.2 19.5 8.2 21.1 3.1 21.1 3.1 20.4 4.5 19.9 5.1 16.4 4.3 13.7 5.6 12.8 4.2 11.4 3.1 11.2 3.1 7.6 4.5 7zM11.8 3.1 13.7 3.1 12.8 4.2zM18.1 3.1 21.2 3.1 21.1 8.2 19.9 8.6 18.1 8.5 17.2 9.6 18.2 11.4 19.1 11.8 19.9 11.8 20.4 10.8 21.1 10.7 20.6 12.3 20.6 14.4 21.1 15.1 21.1 21 10.6 21.1 11.1 20.4 17.3 20 18 16.4 17.2 13.7 18.4 12.8 17 11.4 14.8 11.5 14.3 15 13.5 15.2 13.7 16 12.8 17 11.6 16 11.1 12.3 9.3 10.3 9.1 8.6 9.6 8.1 10.3 9 11.1 7.5 17.1 7.3z",
  "leather": "M6.8 3.1 9.5 3.1 8 4.5zM10.3 3.1 12.9 3.1 10.8 4.8zM13.7 3.6 15.9 6.2 14.7 7.1 12.6 5.1zM3.8 3.7 6 4 5.8 5.8 3.5 5.4zM16.6 3.7 18.9 4 18.8 5.8 16.4 5.5zM11.3 5.4 12.4 6.5 10.8 8.5zM3.8 6.5 5.8 6.6 6.3 8.9 3.1 8.9zM16.6 6.5 18.7 6.6 19.2 8.9 15.2 8.3zM9.2 6.9 9.2 9.2 7.2 8.9zM13.1 7 14.5 8.1 13.2 10.4 11.4 9zM21.2 7.5 21.1 9.3 20.1 8.9zM15 9.2 17.3 10.5 14.1 12.5zM10.2 9.4 13.2 12.6 9.3 11.5zM3.3 9.6 4.5 10.5 3.1 12.5zM18.7 10.1 18 13.7 16.9 12.6zM5.7 10.1 5.1 13.7 4.1 12.6zM9.3 12.4 12.4 13.8 10.1 14.7 8.7 13.9zM8.1 14.5 9.3 17 6.8 17.3 6.4 15.3zM21 14.5 21.1 17.3 19.7 17.3 19.3 15.3zM11.5 15 13 15.8 10.6 17.7zM13.7 16.4 15.9 19.1 14.7 19.9 12.6 18zM3.6 16.6 6 16.9 5.9 18.6 3.9 18.7zM16.5 16.6 18.9 16.9 18.8 18.6 16.5 18.4zM11.4 18.3 12.4 19.4 10.6 21.1zM3.9 19.3 5.8 19.4 6.3 21.1 3.1 21.2zM16.8 19.3 19.1 21.1 15.1 21.1zM9 19.7 9.6 21.1 7.5 21.1zM13.1 19.8 14.5 21.1 11.8 21.1z",
  "wood": "M4.8 3.1 5.6 3.1 5.7 3.6 5.2 9.6 6.3 10.3 6.5 12.1 6.3 13.2 5.4 13.7 5.9 15.6 5.1 17.3 5.7 20.6 5 21.2 4.3 21.1 4.3 14.6 3.1 12.6 3.1 8.9 4.3 7.5 4.2 5.3zM7 3.1 10.8 3.1 11.6 4.2 11.6 5.7 10.3 6.5 11.5 8.7 10.9 10.1 11.1 12.3 11.7 13.2 11.5 14.4 12.4 15.4 12.3 17.7 10.8 19.5 11.6 21.1 6.9 21.1 6.8 19.2 7.4 18.3 6.9 17.6 7.3 16.7 8.8 16.5 7.7 15.3 8.5 14.6 9.6 11.3 7.9 8.9 8 7.2 6.8 5.4zM14.4 3.1 17.4 3.1 18.1 4.2 16.9 8.3 15.2 10.1 15 12.6 15.5 13.7 14.7 15.3 15.3 17.3 16.5 18 18.1 20.6 17.8 21.1 14.9 21.1 14.1 19.4 13.3 13.2 13.5 9.4 15.2 7.3zM21.1 3.1 21.1 21.2 20.7 21.1 20.6 14.6 18.8 12.6 19.3 11.3 18.6 10.1 18.7 9.3 20.7 7.7 20.6 5.3z",
  "stipple": "M3.7 5a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0 -2.6 0zM10 4a1 1 0 1 0 2 0 1 1 0 1 0 -2 0zM16.6 6a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0 -2.8 0zM7 10a1 1 0 1 0 2 0 1 1 0 1 0 -2 0zM12.5 10.5a1.5 1.5 0 1 0 3.0 0 1.5 1.5 0 1 0 -3.0 0zM19 12a1 1 0 1 0 2 0 1 1 0 1 0 -2 0zM2.9 15a1.1 1.1 0 1 0 2.2 0 1.1 1.1 0 1 0 -2.2 0zM8.6 16a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 1 0 -2.8 0zM16 17a1 1 0 1 0 2 0 1 1 0 1 0 -2 0zM5.8 21a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0 -2.4 0zM12.9 20a1.1 1.1 0 1 0 2.2 0 1.1 1.1 0 1 0 -2.2 0zM18.7 20a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0 -2.6 0z",
  "image": "M3 4h18v16H3zM5 6v12h14V6zM7 16l3.5-4 2.5 3 2-2 2 3zM9.5 8.2a1.5 1.5 0 1 0 .01 0z"
}
const picOf = (value: string, label: string) => pic(value, label, SHAPES[value] as string)
const NOISY = "pattern == 'noise' || pattern == 'leather' || pattern == 'wood' || pattern == 'stipple' || pattern == 'bricks'"
const FILLED = "pattern == 'ridges' || pattern == 'dots' || pattern == 'hex_dots' || pattern == 'hexagons' || pattern == 'bricks' || pattern == 'weave' || pattern == 'grid' || pattern == 'stipple'"

const params = (): ParamDef[] => [
  {
    name: 'pattern', type: 'enum', default: 'knurl', importance: 'main', section: 'texture', shape_style: 'fill',
    options: [picOf('knurl', 'Knurl (diamonds)'), picOf('ridges', 'Ridges'), picOf('waves', 'Waves'), picOf('dots', 'Dots'), picOf('hex_dots', 'Dots, hexagonal'), picOf('hexagons', 'Hexagons'), picOf('bricks', 'Bricks'), picOf('weave', 'Weave'), picOf('grid', 'Grid lines'), picOf('noise', 'Noise'), picOf('leather', 'Leather'), picOf('wood', 'Wood grain'), picOf('stipple', 'Stipple'), picOf('image', 'Picture')],
  },
  { name: 'amplitude', type: 'float', default: 0.6, min: -10, max: 10, step: 0.05, unit: 'mm', widget: 'slider', importance: 'main', personalisable: true, section: 'texture', help: 'How far the surface moves. Negative cuts into it.' },
  { name: 'scale', type: 'float', default: 5, min: 0.5, max: 100, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', personalisable: true, section: 'texture', help: 'The size of one tile of the pattern.' },
  { name: 'image', type: 'asset', default: null, accept: ['image/png', 'image/jpeg'], library: 'textures', widget: 'gallery', visible_if: "pattern == 'image'", section: 'texture' },
  { name: 'tiling', type: 'enum', default: 'tile', options: [opt('tile', 'Repeat'), opt('fit', 'Once')], widget: 'segmented', visible_if: "pattern == 'image'", section: 'texture' },
  { name: 'invert', type: 'bool', default: false, section: 'texture', help: 'Swap high and low.' },
  { name: 'seed', type: 'int', default: 1, min: 0, max: 99999, personalisable: true, visible_if: NOISY, section: 'pattern' },
  { name: 'roughness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05, widget: 'slider', visible_if: "pattern == 'noise' || pattern == 'leather' || pattern == 'wood'", section: 'pattern' },
  { name: 'octaves', type: 'int', default: 3, min: 1, max: 6, widget: 'stepper', visible_if: "pattern == 'noise' || pattern == 'wood'", section: 'pattern' },
  { name: 'fill', type: 'float', default: 0.5, min: 0.1, max: 0.95, step: 0.05, widget: 'slider', visible_if: FILLED, section: 'pattern', help: 'How much of each cell the raised feature takes.' },
  { name: 'offset', type: 'float', default: 0, min: 0, max: 1, step: 0.05, widget: 'slider', section: 'pattern', help: 'The zero level: 0 raises from the surface, 1 cuts into it, 0.5 does both.' },
  {
    name: 'mapping', type: 'enum', default: 'triplanar', section: 'mapping', importance: 'advanced',
    options: [opt('triplanar', 'Triplanar'), opt('planar', 'Planar'), opt('cylindrical', 'Cylindrical'), opt('spherical', 'Spherical'), opt('box', 'Box')],
  },
  { name: 'axis', type: 'enum', default: 'z', options: [opt('x', 'X'), opt('y', 'Y'), opt('z', 'Z')], widget: 'segmented', visible_if: "mapping == 'planar' || mapping == 'cylindrical' || mapping == 'spherical'", section: 'mapping' },
  { name: 'blend', type: 'float', default: 4, min: 1, max: 16, step: 0.5, visible_if: "mapping == 'triplanar' || mapping == 'cylindrical'", section: 'mapping', help: 'How sharply the sides of the mapping meet: higher is sharper.' },
  { name: 'rotation', type: 'float', default: 0, min: -180, max: 180, step: 5, unit: 'deg', section: 'mapping' },
  { name: 'offset_u', type: 'float', default: 0, min: -1000, max: 1000, step: 0.5, unit: 'mm', section: 'mapping' },
  { name: 'offset_v', type: 'float', default: 0, min: -1000, max: 1000, step: 0.5, unit: 'mm', section: 'mapping' },
  { name: 'region', type: 'part', kinds: ['segment', 'group'], default: '', allow_empty: true, section: 'region', help: 'Texture only this part. Empty: the whole model.' },
  { name: 'skip_bottom', type: 'bool', default: false, section: 'region', help: 'Leave the bottom smooth: faces that look down (within 20 degrees of flat) get no texture, so the model sits flat on the bed.' },
  { name: 'edge_falloff', type: 'float', default: 1, min: 0, max: 20, step: 0.25, unit: 'mm', section: 'region', help: 'The texture fades out this far from a sharp edge and from the border of the part, so edges stay crisp.' },
  { name: 'segment', type: 'part', kinds: ['segment'], default: '', allow_empty: true, section: 'region', help: 'Give the textured triangles this colour part, for multicolour printing.' },
  { name: 'detail', type: 'enum', default: 'auto', options: [opt('auto', 'Automatic'), opt('fine', 'Fine'), opt('coarse', 'Coarse')], widget: 'segmented', section: 'detail' },
  { name: 'smooth_normals', type: 'bool', default: true, section: 'detail', help: 'Move the surface along smoothed directions, so sharp edges do not tear.' },
  { name: 'max_triangles', type: 'int', default: 1000000, min: 1000, max: 5000000, section: 'detail' },
]

export const textureManifest: Manifest = {
  manifest_version: 1,
  id: TEXTURE_PLUGIN_ID,
  name: 'AtelierMesh texture',
  version: TEXTURE_PLUGIN_VERSION,
  license: 'AGPL-3.0-or-later',
  description: 'Gives a surface a texture: knurls, ridges, hexagons, leather, wood grain and more, or a picture as a height map.',
  contact: { url: 'https://micro-fabriek.be', name: 'micro-fabriek' },
  image: { file: 'plugins/org.ateliermesh.texture.png', alt: 'A block with a pattern of raised hexagons on every face.' },
  operations: [
    {
      id: 'texture', title: 'Surface texture', kind: 'modifier', category: 'surface', icon: 'texture', summary: '{{pattern}} · {{amplitude}} mm', personalisable: 'optional', stages: ['subdivide', 'displace'],
      sections: [
        { id: 'texture', title: 'Texture' },
        { id: 'pattern', title: 'Pattern', collapsed: true },
        { id: 'mapping', title: 'Mapping', collapsed: true },
        { id: 'region', title: 'Region', collapsed: true },
        { id: 'detail', title: 'Detail', collapsed: true },
      ],
      outputs: { mesh: true, report: true, segments: [{ param: 'segment' }] },
      params: params(),
    },
  ],
}

export const texturePlugin = (): PluginEntry => ({ manifest: textureManifest, load: async () => (await import('./texture-run')).default })
