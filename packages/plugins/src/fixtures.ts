// Conformance fixtures for `org.ateliermesh.core`. The Atelier's CI can run them against the vendored package (SPEC section 11).
import { makeStep } from '@ateliermesh/core'
import type { Fixture, Step } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from './core-plugin'
import { LOWPOLY_PLUGIN_ID, LOWPOLY_PLUGIN_VERSION } from './lowpoly-plugin'
import { VORONOI_PLUGIN_ID, VORONOI_PLUGIN_VERSION } from './voronoi-plugin'
import { REPAIR_PLUGIN_ID, REPAIR_PLUGIN_VERSION } from './repair-plugin'
import { PARTS_PLUGIN_ID, PARTS_PLUGIN_VERSION } from './parts-plugin'
import { DEFORM_PLUGIN_ID, DEFORM_PLUGIN_VERSION } from './deform-plugin'
import { TEXTURE_PLUGIN_ID, TEXTURE_PLUGIN_VERSION } from './texture-plugin'
import { HOLLOW_PLUGIN_ID, HOLLOW_PLUGIN_VERSION } from './hollow-plugin'
import { HOLES_PLUGIN_ID, HOLES_PLUGIN_VERSION } from './holes-plugin'
import { PRINTCHECK_PLUGIN_ID, PRINTCHECK_PLUGIN_VERSION } from './printcheck-plugin'

const step = (id: string, op: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op, params })
const lp = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: LOWPOLY_PLUGIN_ID, version: LOWPOLY_PLUGIN_VERSION }, op: 'low_poly', params: { triangles_mode: 'fixed', ...params } })
const L = { kind: 'generator', name: 'l_bracket' } as const // 40 x 20 x 10, volume 6000, bbox (0,0,0) to (40,20,10)

export const coreFixtures: Fixture[] = [
  {
    name: 'resize 150 percent about the bbox centre',
    input: L, steps: [step('r', 'resize', { percent: 150 })],
    expect: { size: { value: [60, 30, 15], tol: 1e-6 }, volume: { value: 6000 * 3.375, tol: 1e-3 }, bbox: { min: [-10, -5, -2.5], max: [50, 25, 12.5], tol: 1e-6 }, watertight: true, step_reports: [{ step: 0, key: 'factor', expect: { value: 1.5, tol: 1e-9 } }] },
  },
  {
    name: 'resize to 80 mm along x',
    input: L, steps: [step('r', 'resize', { mode: 'target_size', target_axis: 'x', target_mm: 80 })],
    expect: { size: { value: [80, 40, 20], tol: 1e-6 }, volume: { value: 48000, tol: 1e-3 } },
  },
  {
    name: 'resize 200 percent about the origin',
    input: L, steps: [step('r', 'resize', { percent: 200, pivot: 'origin' })],
    expect: { bbox: { min: [0, 0, 0], max: [80, 40, 20], tol: 1e-6 } },
  },
  {
    name: 'resize 50 percent about the bottom centre keeps the base on the plate',
    input: L, steps: [step('r', 'resize', { percent: 50, pivot: 'bbox_bottom_center' })],
    expect: { size: { value: [20, 10, 5], tol: 1e-6 }, bbox: { min: [10, 5, 0], max: [30, 15, 5], tol: 1e-6 } },
  },
  {
    name: 'resize along a flat axis fails with a clear code',
    input: { kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    steps: [step('r', 'resize', { mode: 'target_size', target_axis: 'z', target_mm: 10 })],
    expect: { ok: false, error_code: 'resize.zero_size' },
  },
  {
    name: 'rotate 90 degrees about z around the origin swaps x and y',
    input: L, steps: [step('r', 'rotate', { angles: [0, 0, 90], pivot: 'origin' })],
    expect: { size: { value: [20, 40, 10], tol: 1e-9 }, volume: { value: 6000, tol: 1e-6 }, bbox: { min: [-20, 0, 0], max: [0, 40, 10], tol: 1e-9 } },
  },
  {
    name: 'rotate 90 degrees about x around the bbox centre swaps y and z',
    input: L, steps: [step('r', 'rotate', { angles: [90, 0, 0] })],
    expect: { size: { value: [40, 10, 20], tol: 1e-9 }, volume: { value: 6000, tol: 1e-6 }, bbox: { min: [0, 5, -5], max: [40, 15, 15], tol: 1e-9 } },
  },
  {
    name: 'rotate with a snap step rounds the angles',
    input: L, steps: [step('r', 'rotate', { angles: [0, 0, 87], snap_step: 45, pivot: 'origin' })],
    expect: { size: { value: [20, 40, 10], tol: 1e-9 } },
  },
  {
    name: 'rotate order matters: X then Y differs from Y then X',
    input: L, steps: [step('r', 'rotate', { angles: [90, 90, 0], order: 'XYZ', pivot: 'origin' })],
    expect: { bbox: { min: [0, -10, -40], max: [20, 0, 0], tol: 1e-9 } },
  },
  {
    name: 'overhang of an L-bracket standing upright is zero',
    input: L, steps: [step('o', 'overhang', {})],
    expect: { step_reports: [{ step: 0, key: 'area', expect: { value: 0, tol: 1e-9 } }, { step: 0, key: 'bed_area', expect: { value: 600, tol: 1e-9 } }] },
  },
  {
    name: 'overhang of an L-bracket turned on its side',
    // lying on the 40 x 10 face (y = 20 side down after a 90 degree turn about x): the 20 x 10 notch face hangs
    input: L, steps: [step('r', 'rotate', { angles: [-90, 0, 0] }), step('o', 'overhang', {})],
    expect: { step_reports: [{ step: 1, key: 'height', expect: { value: 20, tol: 1e-9 } }] },
  },
  {
    name: 'auto_orient keeps the L-bracket flat for min_height',
    input: L, steps: [step('a', 'auto_orient', { goal: 'min_height' })],
    expect: { step_reports: [{ step: 0, key: 'goal', expect: 'min_height' }] },
  },
  {
    name: 'decimate a sphere to about a third of its triangles and keep it closed',
    input: { kind: 'generator', name: 'sphere', params: { radius: 10, subdivisions: 4 } },
    steps: [step('d', 'decimate', { mode: 'target', target_triangles: 1700 })],
    expect: { triangles: { min: 1660, max: 1740 }, watertight: true, volume: { value: 4188.8, tol: 250 } },
  },
]

/** Conformance fixtures for `org.ateliermesh.lowpoly`. */
export const lowpolyFixtures: Fixture[] = [
  {
    name: 'low poly: a sphere of 5120 triangles to about 800 stays a closed solid with nearly its volume',
    input: { kind: 'generator', name: 'sphere', params: { radius: 10, subdivisions: 4 } },
    steps: [lp('l', { triangles: 800 })],
    expect: { triangles: { min: 760, max: 840 }, watertight: true, volume: { value: 4188.8, tol: 420 } },
  },
  {
    name: 'low poly: a model that already has fewer triangles than the target comes back unchanged',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [lp('l', { triangles: 500 })],
    expect: { triangles: { min: 12, max: 12 }, volume: { value: 6000, tol: 1e-6 }, size: { value: [10, 20, 30], tol: 1e-9 }, watertight: true },
  },
]

const vo = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi', params: { placement: { anchor: { point: [0, 0, 5], normal: [0, 0, 1] } }, ...params } })

/** Conformance fixtures for `org.ateliermesh.voronoi`: a 60 x 40 x 5 mm plate, the pattern in a 30 x 20 mm area in the middle of its top. */
export const voronoiFixtures: Fixture[] = [
  {
    name: 'voronoi: flat mode only recolours, so the plate keeps its volume and stays closed',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [vo('v', { mode: 'flat', width: 30, height_area: 20, cells: 12, seed: 3 })],
    expect: { watertight: true, volume: { value: 12000, tol: 1e-3 }, bbox: { min: [-30, -20, 0], max: [30, 20, 5], tol: 1e-6 } },
  },
  {
    name: 'voronoi: raised lines add material and stay one closed solid',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [vo('v', { mode: 'raised', height: 1, width: 30, height_area: 20, cells: 12, seed: 3 })],
    expect: { watertight: true, volume: { value: 12225, tol: 125 }, bbox: { min: [-30, -20, 0], max: [30, 20, 6], tol: 1e-6 } },
  },
  {
    name: 'voronoi: more cells than the area can print is a clear error',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [vo('v', { width: 10, height_area: 10, cells: 2000 })],
    expect: { ok: false, error_code: 'voronoi.cells_too_small' },
  },
  {
    name: 'voronoi shell: a sphere becomes a hollow lattice that is one closed solid with a fraction of the volume',
    input: { kind: 'generator', name: 'sphere', params: { radius: 12, subdivisions: 4 } },
    steps: [makeStep({ id: 'vs', plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi_shell', params: { thickness: 1.5, rib_width: 1.5, cells: 20, seed: 2, detail: 'coarse' } })],
    expect: { watertight: true, triangles: { min: 5000, max: 60000 }, volume: { value: 480, tol: 160 } },
  },
  {
    name: 'voronoi shell: a model that is not a closed solid is refused with a clear reason',
    input: { kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    steps: [makeStep({ id: 'vs', plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi_shell', params: {} })],
    expect: { ok: false, error_code: 'voronoi_shell.bad_input' },
  },
  {
    name: 'voronoi shell: more openings than the surface has room for is a clear error',
    input: { kind: 'generator', name: 'sphere', params: { radius: 10, subdivisions: 3 } },
    steps: [makeStep({ id: 'vs', plugin: { id: VORONOI_PLUGIN_ID, version: VORONOI_PLUGIN_VERSION }, op: 'voronoi_shell', params: { cells: 1500, rib_width: 5 } })],
    expect: { ok: false, error_code: 'voronoi_shell.cells_too_small' },
  },
]

const rp = (id: string, params: Record<string, unknown> = {}): Step => makeStep({ id, plugin: { id: REPAIR_PLUGIN_ID, version: REPAIR_PLUGIN_VERSION }, op: 'repair_mesh', params })
const CUBE = [-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0, -5, -5, 10, 5, -5, 10, 5, 5, 10, -5, 5, 10] // a 10 mm cube standing on z = 0
const CUBE_TRIS = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]

/** Conformance fixtures for `org.ateliermesh.repair`: a damaged cube comes back as the closed cube it was. */
export const repairFixtures: Fixture[] = [
  {
    name: 'repair: a cube with one triangle missing is closed again with its exact volume',
    input: { kind: 'mesh', positions: CUBE, indices: CUBE_TRIS.slice(0, 33) },
    steps: [rp('r')],
    expect: { watertight: true, triangles: 12, volume: { value: 1000, tol: 1e-6 }, size: { value: [10, 10, 10], tol: 1e-9 }, step_reports: [{ step: 0, key: 'holes_filled', expect: 1 }] },
  },
  {
    name: 'repair: a cube with three triangles turned inside out is consistent and points outward',
    input: { kind: 'mesh', positions: CUBE, indices: CUBE_TRIS.map((v, i) => { const t = (i / 3) | 0, k = i % 3; return [0, 4, 9].includes(t) ? CUBE_TRIS[3 * t + (k === 1 ? 2 : k === 2 ? 1 : 0)] as number : v }) },
    steps: [rp('r')],
    expect: { watertight: true, triangles: 12, volume: { value: 1000, tol: 1e-6 }, step_reports: [{ step: 0, key: 'flipped_triangles', expect: 3 }] },
  },
  {
    name: 'repair: a cube that is entirely inside out is turned right way round',
    input: { kind: 'mesh', positions: CUBE, indices: CUBE_TRIS.map((v, i) => { const t = (i / 3) | 0, k = i % 3; return CUBE_TRIS[3 * t + (k === 1 ? 2 : k === 2 ? 1 : 0)] as number }) },
    steps: [rp('r')],
    expect: { watertight: true, volume: { value: 1000, tol: 1e-6 } },
  },
]

const df = (id: string, op: 'twist' | 'taper' | 'smooth' | 'bend' | 'wave' | 'ripple', params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: DEFORM_PLUGIN_ID, version: DEFORM_PLUGIN_VERSION }, op, params })

/** Conformance fixtures for `org.ateliermesh.deform`: a 10 x 10 x 40 mm pillar standing on z = 0. */
export const deformFixtures: Fixture[] = [
  {
    name: 'deform: a 90 degree twist keeps the pillar one closed solid with the same volume',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('t', 'twist', { angle: 90 })],
    expect: { watertight: true, volume: { value: 4000, tol: 40 }, triangles: { min: 100, max: 100000 } },
  },
  {
    name: 'deform: a twist of 0 degrees leaves the pillar exactly as it was',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('t', 'twist', { angle: 0 })],
    expect: { watertight: true, triangles: 12, volume: { value: 4000, tol: 1e-6 }, size: { value: [10, 10, 40], tol: 1e-9 } },
  },
  {
    name: 'deform: tapering to 50 percent gives the volume of the frustum',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('t', 'taper', { scale_end: 0.5 })],
    expect: { watertight: true, volume: { value: 2333.33, tol: 24 }, size: { value: [10, 10, 40], tol: 1e-6 } },
  },
  {
    name: 'deform: a 90 degree bend keeps the bar one closed solid with the volume (Pappus) it had',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('b', 'bend', { angle: 90 })],
    expect: { watertight: true, volume: { value: 4000, tol: 40 }, triangles: { min: 100, max: 100000 } },
  },
  {
    name: 'deform: a bend of 0 degrees leaves the bar exactly as it was',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('b', 'bend', { angle: 0 })],
    expect: { watertight: true, triangles: 12, volume: { value: 4000, tol: 1e-6 }, size: { value: [10, 10, 40], tol: 1e-9 } },
  },
  {
    name: 'deform: a bend along and towards the same axis is a clear error',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('b', 'bend', { angle: 90, axis: 'z', bend_axis: 'z' })],
    expect: { ok: false, error_code: 'deform.bad_axes' },
  },
  {
    name: 'deform: a wave along a plate keeps it one closed solid with the same volume (a shear)',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [df('w', 'wave', { amplitude: 1, wavelength: 20 })],
    expect: { watertight: true, volume: { value: 12000, tol: 12 }, triangles: { min: 100, max: 200000 } },
  },
  {
    name: 'deform: a ripple on a plate keeps it one closed solid with the same volume (a shear)',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [df('r', 'ripple', { amplitude: 1, wavelength: 10, detail: 'coarse' })],
    expect: { watertight: true, volume: { value: 12000, tol: 12 }, triangles: { min: 100, max: 300000 } },
  },
  {
    name: 'deform: a wave of height 0 leaves the plate exactly as it was',
    input: { kind: 'generator', name: 'box', params: { width: 60, depth: 40, height: 5 } },
    steps: [df('w', 'wave', { amplitude: 0, wavelength: 20 })],
    expect: { watertight: true, triangles: 12, volume: { value: 12000, tol: 1e-6 } },
  },
  {
    name: 'deform: a range that is empty is a clear error',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('t', 'twist', { angle: 90, from: 0.8, to: 0.2 })],
    expect: { ok: false, error_code: 'deform.bad_range' },
  },
]

/** Conformance fixtures for the `smooth` operation of `org.ateliermesh.deform`. */
export const smoothFixtures: Fixture[] = [
  {
    name: 'smooth: a box keeps its corners, so it comes back as the same box',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 10, height: 40 } },
    steps: [df('s', 'smooth', {})],
    expect: { watertight: true, triangles: 12, volume: { value: 4000, tol: 1e-6 }, size: { value: [10, 10, 40], tol: 1e-9 } },
  },
  {
    name: 'smooth: a ball stays one closed solid with about the same volume and the same triangles',
    input: { kind: 'generator', name: 'sphere', params: { radius: 10, subdivisions: 3 } },
    steps: [df('s', 'smooth', { iterations: 10, keep_edges: 180 })],
    expect: { watertight: true, triangles: 1280, volume: { value: 4170, tol: 45 } },
  },
]

/** Fixtures that MUST fail: a plugin that lies (says 100 percent but the mesh stays tiny) is caught by the checks. */
export const cheatFixtures: Fixture[] = [
  {
    name: 'cheat: 100 percent resize of a tiny cube cannot satisfy a 50 mm expectation',
    input: { kind: 'generator', name: 'box', params: { width: 1, depth: 1, height: 1 } },
    steps: [step('r', 'resize', { percent: 100 })],
    expect: { size: { value: [50, 50, 50], tol: 0.01 } },
  },
]

const pt = (id: string, op: 'delete_part' | 'keep_part', params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: PARTS_PLUGIN_ID, version: PARTS_PLUGIN_VERSION }, op, params })

/** Conformance fixtures for `org.ateliermesh.parts`. Fixture meshes carry no segments or groups, so these cover the whole-mesh cases and the errors. */
export const partsFixtures: Fixture[] = [
  {
    name: 'parts: keeping the whole surface (the default segment) changes nothing',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [pt('k', 'keep_part', { part: 'body' })],
    expect: { watertight: true, volume: { value: 6000, tol: 1e-6 }, triangles: 12 },
  },
  {
    name: 'parts: deleting every triangle is refused',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [pt('d', 'delete_part', { part: 'body' })],
    expect: { ok: false, error_code: 'parts.would_remove_everything' },
  },
  {
    name: 'parts: no part chosen is refused',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [pt('d', 'delete_part', {})],
    expect: { ok: false, error_code: 'parts.nothing_chosen' },
  },
  {
    name: 'parts: a part the mesh does not have is refused',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [pt('d', 'delete_part', { part: 'lid' })],
    expect: { ok: false, error_code: 'part.unknown' },
  },
]

const tex = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: TEXTURE_PLUGIN_ID, version: TEXTURE_PLUGIN_VERSION }, op: 'texture', params })
export const textureFixtures: Fixture[] = [
  {
    name: 'texture: an amplitude of 0 leaves the cube exactly as it was',
    input: { kind: 'generator', name: 'box', params: { width: 20, depth: 20, height: 20 } },
    steps: [tex('t', { amplitude: 0 })],
    expect: { watertight: true, triangles: 12, volume: { value: 8000, tol: 1e-6 }, size: { value: [20, 20, 20], tol: 1e-9 } },
  },
  {
    name: 'texture: a knurl on a cube stays one closed solid, a little larger, and the edges stay where they were',
    input: { kind: 'generator', name: 'box', params: { width: 20, depth: 20, height: 20 } },
    steps: [tex('t', { pattern: 'knurl', amplitude: 0.6, scale: 5 })],
    expect: { watertight: true, volume: { value: 8000 + 600, tol: 500 }, triangles: { min: 1000, max: 400000 } },
  },
  {
    name: 'texture: a surface that would need too many triangles is refused with a clear code',
    input: { kind: 'generator', name: 'box', params: { width: 40, depth: 40, height: 10 } },
    steps: [tex('t', { pattern: 'knurl', scale: 4, max_triangles: 2000 })],
    expect: { ok: false, error_code: 'texture.too_heavy' },
  },
]

const hol = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: HOLLOW_PLUGIN_ID, version: HOLLOW_PLUGIN_VERSION }, op: 'hollow', params })
/** Conformance fixtures for `org.ateliermesh.hollow`: a ball of 12 mm radius (volume about 7000 mm3), hollowed to a 2 mm wall (about 3000 mm3). */
export const hollowFixtures: Fixture[] = [
  {
    name: 'hollow: a ball gets a cavity, stays one closed solid, and the wall is as thick as asked',
    input: { kind: 'generator', name: 'sphere', params: { radius: 12, subdivisions: 4 } },
    steps: [hol('h', { thickness: 2, detail: 'coarse' })],
    expect: { watertight: true, triangles: { min: 3000, max: 200000 }, volume: { value: 3000, tol: 250 }, step_reports: [{ step: 0, key: 'hollowed', expect: true }, { step: 0, key: 'wall_min_mm', expect: { value: 2, tol: 0.35 } }] },
  },
  {
    name: 'hollow: a model that is not a closed solid is refused with a clear reason',
    input: { kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    steps: [hol('h', {})],
    expect: { ok: false, error_code: 'hollow.bad_input' },
  },
  {
    name: 'hollow: a wall thicker than the model leaves the model as it was',
    input: { kind: 'generator', name: 'box', params: { width: 6, depth: 6, height: 6 } },
    steps: [hol('h', { thickness: 10 })],
    expect: { watertight: true, triangles: 12, volume: { value: 216, tol: 1e-6 }, step_reports: [{ step: 0, key: 'hollowed', expect: false }] },
  },
  {
    name: 'hollow: an opening at the bottom keeps one closed solid',
    input: { kind: 'generator', name: 'sphere', params: { radius: 12, subdivisions: 4 } },
    steps: [hol('h', { thickness: 2, opening: 'bottom', opening_diameter: 6, detail: 'coarse' })],
    expect: { watertight: true, triangles: { min: 3000, max: 200000 }, volume: { value: 2900, tol: 350 }, step_reports: [{ step: 0, key: 'outer_remeshed', expect: false }] },
  },
]

const pc = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: PRINTCHECK_PLUGIN_ID, version: PRINTCHECK_PLUGIN_VERSION }, op: 'printability', params })
/** Conformance fixtures for `org.ateliermesh.printcheck`: an analyzer, so the mesh comes back as it was and only the report differs. */
export const printcheckFixtures: Fixture[] = [
  {
    name: 'printcheck: a solid 30 mm cube is good to print and the mesh is not changed',
    input: { kind: 'generator', name: 'box', params: { width: 30, depth: 30, height: 30 } },
    steps: [pc('p', { bed: [220, 220, 250] })],
    expect: { watertight: true, triangles: 12, volume: { value: 27000, tol: 1e-6 }, step_reports: [{ step: 0, key: 'verdict', expect: 'good' }] },
  },
  {
    name: 'printcheck: a model that is bigger than the bed is not printable',
    input: { kind: 'generator', name: 'box', params: { width: 300, depth: 300, height: 10 } },
    steps: [pc('p', { bed: [100, 100, 100] })],
    expect: { watertight: true, triangles: 12, step_reports: [{ step: 0, key: 'verdict', expect: 'not_printable' }] },
  },
  {
    name: 'printcheck: a surface with a hole is reported as not closed',
    input: { kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    steps: [pc('p', {})],
    expect: { step_reports: [{ step: 0, key: 'verdict', expect: 'not_printable' }] },
  },
]

const hole = (id: string, params: Record<string, unknown>): Step => makeStep({ id, plugin: { id: HOLES_PLUGIN_ID, version: HOLES_PLUGIN_VERSION }, op: 'cut_hole', params })
const onTop = (x: number, y: number, z: number) => ({ anchor: { point: [x, y, z], normal: [0, 0, 1] }, direction: 0, up_ref: 'z' })
/** Conformance fixtures for `org.ateliermesh.holes`: a 10 x 20 x 30 box (volume 6000, z from 0 to 30) gets a round hole of 4 mm through it (about 377 mm3). */
export const holesFixtures: Fixture[] = [
  {
    name: 'holes: a round through hole removes a cylinder and leaves one closed solid',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [hole('h', { placement: onTop(0.5, 0.5, 30), diameter: 4 })],
    expect: { watertight: true, volume: { value: 6000 - Math.PI * 4 * 30, tol: 3 }, step_reports: [{ step: 0, key: 'closed', expect: true }, { step: 0, key: 'through', expect: true }] },
  },
  {
    name: 'holes: a blind hole stops at its depth',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [hole('h', { placement: onTop(0.5, 0.5, 30), diameter: 4, depth: 10 })],
    expect: { watertight: true, volume: { value: 6000 - Math.PI * 4 * 10, tol: 3 }, step_reports: [{ step: 0, key: 'through', expect: false }] },
  },
  {
    name: 'holes: a step that has no place yet is refused with a clear reason',
    input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } },
    steps: [hole('h', { placement: null })],
    expect: { ok: false, error_code: 'holes.no_placement' },
  },
]
