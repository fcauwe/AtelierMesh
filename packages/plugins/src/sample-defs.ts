// Example models with steps, as plain data, for a host's start page or tests (the standalone shows them as its sample cards). The steps use the plugins in this
// package. A host that has its own font ids passes `fontIds` to `sampleSteps`. The samples on the start page: a model, and for most of them a few steps already set up, so a visitor sees what the engine does at once.
// A sample is plain data (a base shape and steps), so a hash of it says whether its pre-rendered picture (public/samples/<id>.png) is still right.
import { addStep, emptyStepList, makeStep, parseStl } from '@ateliermesh/core'
import type { Mesh, Registry, StepList } from '@ateliermesh/core'
import { CORE_PLUGIN_ID } from './core-plugin'
import { DEFORM_PLUGIN_ID } from './deform-plugin'
import { VORONOI_PLUGIN_ID } from './voronoi-plugin'
import { TEXTURE_PLUGIN_ID } from './texture-plugin'
import { HOLLOW_PLUGIN_ID } from './hollow-plugin'
import { HOLES_PLUGIN_ID } from './holes-plugin'
import { frustum, gridBox, sphere } from './samples'

export interface StepSpec { plugin: string; op: string; params: Record<string, unknown>; name?: string }
export type BaseSpec =
  | { kind: 'box'; w: number; d: number; h: number; nx: number; ny: number; nz: number }
  | { kind: 'frustum'; r0: number; r1: number; h: number; segments: number; rings: number }
  | { kind: 'sphere'; r: number; subdivisions: number }
  // a model file shipped with the app (public/samples/<file>), read when the sample is opened; `triangles` is in the hash so a new file gives a new picture
  | { kind: 'stl'; file: string; triangles: number }
export interface Sample { id: string; name: string; base: BaseSpec; mesh: () => Mesh | Promise<Mesh>; steps: StepSpec[] }

const loadStl = async (file: string): Promise<Mesh> => {
  const r = await fetch(file)
  if (!r.ok) throw new Error(`${file}: ${r.status}`)
  return parseStl(new Uint8Array(await r.arrayBuffer())).mesh
}
const baseMesh = (b: BaseSpec): Mesh | Promise<Mesh> => (b.kind === 'stl' ? loadStl(b.file) : b.kind === 'box' ? gridBox(b.w, b.d, b.h, b.nx, b.ny, b.nz) : b.kind === 'sphere' ? sphere(b.r, b.subdivisions) : frustum(b.r0, b.r1, b.h, b.segments, b.rings))
export const sample = (id: string, name: string, base: BaseSpec, steps: StepSpec[]): Sample => ({ id, name, base, mesh: () => baseMesh(base), steps })
const box = (w: number, d: number, h: number, nx: number, ny: number, nz: number): BaseSpec => ({ kind: 'box', w, d, h, nx, ny, nz })
const cyl = (r0: number, r1: number, h: number): BaseSpec => ({ kind: 'frustum', r0, r1, h, segments: 96, rings: 40 })

const onTop = (z: number): Record<string, unknown> => ({ anchor: { point: [0, 0, z], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' })

export const SAMPLES: Sample[] = [
  // a tall block, tapered, then twisted, with the name on it and a texture on the body only (the texture's region is the body, so the text stays smooth)
  sample('standingbar', 'Standing bar', box(24, 24, 70, 24, 24, 70),
    [{ plugin: DEFORM_PLUGIN_ID, op: 'taper', name: 'Taper', params: { scale_end: 0.55 } },
     { plugin: DEFORM_PLUGIN_ID, op: 'twist', name: 'Twist', params: { angle: 90 } },
     { plugin: CORE_PLUGIN_ID, op: 'emboss', name: 'Name', params: { text: 'AtelierMesh', font: 'font:Quicksand', size: 5, height: 0.6, mode: 'raised', placement: { anchor: { point: [5.8997, -7.5513, 31.5], normal: [0.6397, -0.7662, 0.0616] }, direction: 75, up_ref: 'z' } } },
     { plugin: TEXTURE_PLUGIN_ID, op: 'texture', name: 'Texture', params: { pattern: 'knurl', amplitude: 0.4, scale: 3, edge_falloff: 1, region: 'body' } }]),
  // a tapered vase hollowed into a lattice of struts with an open top, then smoothed: the struts of the raw result are a little ridged
  sample('voronoishell', 'Voronoi shell', cyl(14, 20, 50),
    [{ plugin: VORONOI_PLUGIN_ID, op: 'voronoi_shell', name: 'Lattice', params: { thickness: 2, rib_width: 2, cells: 70, seed: 3, opening: 'top', opening_diameter: 26 } },
     { plugin: DEFORM_PLUGIN_ID, op: 'smooth', name: 'Smooth', params: { iterations: 10, strength: 0.5 } }]),
  // a jar hollowed to a 2 mm wall with a round opening in the top (a straight shape, so the opening has the same wall all round)
  sample('hollowjar', 'Hollow jar', cyl(20, 20, 40),
    [{ plugin: HOLLOW_PLUGIN_ID, op: 'hollow', name: 'Hollow', params: { thickness: 2, opening: 'top', opening_diameter: 30 } }]),
  // a name tag with a 4 mm hole near the end for a keyring: the text goes on first, the hole is cut after it
  sample('keyringtag', 'Name tag with keyring hole', box(70, 30, 4, 140, 60, 8),
    [{ plugin: CORE_PLUGIN_ID, op: 'emboss', name: 'Name', params: { text: 'Anna', font: 'font:Roboto', size: 12, height: 0.8, mode: 'raised', placement: { anchor: { point: [-4, 0, 4], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' } } },
     { plugin: HOLES_PLUGIN_ID, op: 'cut_hole', name: 'Keyring hole', params: { shape: 'round', diameter: 4, depth: 0, placement: { anchor: { point: [28.5, 0, 4], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' } } }]),
  sample('nametag', 'Name tag', box(70, 30, 4, 140, 60, 8),
    [{ plugin: CORE_PLUGIN_ID, op: 'emboss', name: 'Name', params: { text: 'Anna', font: 'font:Roboto', size: 12, height: 0.8, mode: 'raised', placement: onTop(4) } }]),
  // two operations in one: twist the pillar, then put the name on the twisted face (the order matters: text goes on after the twist)
  // a surface texture on every face of a block (the edges stay crisp: the texture fades out before them)
  sample('texblock', 'Textured block', box(40, 30, 20, 40, 30, 20),
    [{ plugin: TEXTURE_PLUGIN_ID, op: 'texture', name: 'Hexagons', params: { pattern: 'hexagons', amplitude: 0.8, scale: 6, fill: 0.55, edge_falloff: 1.5 } }]),
  // the 3DBenchy (Creative Tools, CC BY-ND 4.0), reduced to 40,000 triangles, with rings across the whole boat
  sample('benchy', '3DBenchy ripple', { kind: 'stl', file: 'samples/benchy.stl', triangles: 40000 },
    [{ plugin: DEFORM_PLUGIN_ID, op: 'ripple', name: 'Ripple', params: { amplitude: 1.4, wavelength: 8, detail: 'coarse' } }]),
  sample('twistname', 'Twisted name', box(30, 30, 44, 30, 30, 44),
    [{ plugin: DEFORM_PLUGIN_ID, op: 'twist', name: 'Twist', params: { angle: 90 } },
     { plugin: CORE_PLUGIN_ID, op: 'emboss', name: 'Name', params: { text: 'Anna', font: 'font:Roboto', size: 8, height: 0.6, mode: 'raised', placement: { anchor: { point: [10.607, -10.607, 22], normal: [0.7064, -0.7064, 0.0452] }, direction: 0, up_ref: 'z' } } }]),
  sample('voronoi', 'Voronoi tile', box(80, 50, 4, 160, 100, 8),
    [{ plugin: VORONOI_PLUGIN_ID, op: 'voronoi', name: 'Pattern', params: { width: 64, height_area: 38, cells: 36, seed: 4, line_width: 1.2, mode: 'raised', height: 0.8, placement: onTop(4) } }]),
  sample('twist', 'Twisted pillar', box(14, 14, 40, 14, 14, 40),
    [{ plugin: DEFORM_PLUGIN_ID, op: 'twist', name: 'Twist', params: { angle: 120 } }]),
  // bend and ripple: the other two shape changes of the deform plugin
  sample('bend', 'Bent bar', box(14, 14, 60, 14, 14, 60),
    [{ plugin: DEFORM_PLUGIN_ID, op: 'bend', name: 'Bend', params: { angle: 75 } }]),
  sample('vase', 'Tapered vase', cyl(15, 15, 40),
    [{ plugin: DEFORM_PLUGIN_ID, op: 'taper', name: 'Narrow top', params: { scale_end: 0.5 } }]),
  sample('plate', 'Plate 60 x 30 x 4', box(60, 30, 4, 120, 60, 8), []),
  sample('cylinder', 'Cylinder r15 h40', cyl(15, 15, 40), []),
]

/** The step list of a sample, with every parameter the sample does not name set to the operation's default. `fontIds` replaces font ids the sample names (for example `{ 'font:Roboto': 'my-roboto' }`). */
export function sampleSteps(registry: Registry, sample: Sample, o: { fontIds?: Record<string, string> } = {}): StepList {
  let list = emptyStepList()
  sample.steps.forEach((s, i) => {
    const found = registry.operation(s.plugin, s.op)
    if (!found) return
    const defaults = Object.fromEntries(found.op.params.filter(p => p.default !== undefined).map(p => [p.name, p.default]))
    const params: Record<string, unknown> = { ...defaults, ...s.params }
    for (const p of found.op.params) { const v = params[p.name]; if (p.type === 'asset' && typeof v === 'string' && o.fontIds?.[v] !== undefined) params[p.name] = o.fontIds[v] }
    list = addStep(list, makeStep({ id: `s${i + 1}`, plugin: { id: s.plugin, version: found.manifest.version }, op: s.op, params, ...(s.name ? { name: s.name } : {}) }))
  })
  return list
}
