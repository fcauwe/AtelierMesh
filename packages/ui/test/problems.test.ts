import { describe, expect, it } from 'vitest'
import { describeProblem, stageKey } from '../src/problems'

describe('Voronoi problems', () => {
  it('a thin line is a warning with a way out; too many cells is an error with the number that works', () => {
    expect(describeProblem('voronoi.thin_lines', { stroke: 0.4, min: 0.6, min_line: 0.6 })).toMatchObject({ kind: 'warning', blocks: false, key: 'mesh.voronoi.thin_lines', values: { width: 0.4, min: 0.6 }, actions: [{ key: 'fix.thickerLines', set: { line_width: 0.6 } }] })
    expect(describeProblem('voronoi.cells_too_small', { cells: 500, max_cells: 120 })).toMatchObject({ kind: 'error', blocks: true, values: { cells: 500, max: 120 }, actions: [{ key: 'fix.fewerCells', set: { cells: 120 } }] })
    expect(describeProblem('voronoi.too_heavy', { cells: 1000, vertices: 70000 }).actions[0]).toMatchObject({ set: { cells: 500 } })
    expect(describeProblem('voronoi.does_not_fit', { reason: 'emboss.touches_patch_edge' })).toMatchObject({ kind: 'error', actions: [{ command: 'place_again' }, { key: 'fix.makeSmaller' }] })
    expect(stageKey('pattern')).toBe('work.pattern')
  })
})

describe('describeProblem', () => {
  it('follows the engine: five warnings and infos do not block, thrown errors do', () => {
    for (const c of ['emboss.text_small', 'emboss.thin_strokes', 'emboss.stretch']) expect(describeProblem(c)).toMatchObject({ kind: 'warning', blocks: false })
    for (const c of ['lowpoly.already_smaller', 'lowpoly.target_not_reached', 'lowpoly.volume_changed']) expect(describeProblem(c)).toMatchObject({ kind: 'warning', blocks: false })
    expect(describeProblem('lowpoly.volume_changed', { percent: -18.4 })).toMatchObject({ key: 'mesh.lowpoly.volume_changed_smaller', values: { pct: 18 } })
    expect(describeProblem('lowpoly.target_not_reached', { target: 12, triangles: 40 })).toMatchObject({ values: { target: 12, count: 40 } })
    expect(stageKey('crystallise')).toBe('work.crystallise')
    for (const c of ['emboss.text_scaled_to_fit', 'run.cancelled']) expect(describeProblem(c)).toMatchObject({ kind: 'info', blocks: false })
    for (const c of ['emboss.touches_patch_edge', 'emboss.wall_too_thin', 'emboss.missing_glyphs', 'budget.triangles', 'run.timeout']) expect(describeProblem(c)).toMatchObject({ kind: 'error', blocks: true })
    expect(describeProblem('placement.too_far')).toMatchObject({ kind: 'warning', blocks: false })   // the page clamps these first
  })
  it('turns engine details into the numbers the texts use', () => {
    expect(describeProblem('emboss.too_much_stretch', { stretch: 1.62, limit: 1.5 }).values).toEqual({ pct: 62, max: 50 })
    expect(describeProblem('emboss.wall_too_thin', { available: 1.234, depth: 1.5, needed: 1.9 }).values).toEqual({ depth: 1.5, wall: 1.2 })
    expect(describeProblem('emboss.missing_glyphs', { characters: ['漢', '字'] }).values).toEqual({ characters: '漢 字' })
    expect(describeProblem('budget.triangles', { triangles: 3_000_000, max: 2_000_000, of: 'file' }).values).toEqual({ count: 3_000_000, max: 2_000_000 })
    expect(describeProblem('run.timeout', { ms: 60000 }).values).toEqual({ seconds: 60 })
    expect(describeProblem('apply.step_failed', { step: 's2' })).toMatchObject({ key: 'mesh.apply.failed', values: { step: 's2' } })
  })
  it('offers a sized button when the engine named a size, and a plain one when it did not', () => {
    const withFit = describeProblem('emboss.touches_patch_edge', { reason: 'outside_patch', fit_size: 6.4 })
    expect(withFit.actions[0]).toMatchObject({ key: 'fix.makeFit', values: { fit_size: 6.4 }, set: { size: 6.4 } })
    expect(describeProblem('emboss.touches_patch_edge').actions[0]).toMatchObject({ key: 'fix.makeSmaller' })
    expect(describeProblem('emboss.touches_patch_edge', { stopped_at_crease: true }).key).toBe('mesh.emboss.touches_patch_edge_crease')
    const wall = describeProblem('emboss.wall_too_thin', { available: 1.4, depth: 1.5, needed: 1.9, fit_height: 1 })
    expect(wall.actions.map(a => a.set)).toEqual([{ mode: 'raised' }, { height: 1 }])
  })
  it('maps stages to labels with a fallback', () => {
    expect(stageKey('unfold')).toBe('work.unfold')
    expect(stageKey('mystery')).toBe('work.other')
  })
  it('a crashed plugin and a switched-off plugin offer to switch it on again', () => {
    expect(describeProblem('plugin.crashed', { plugin: 'org.x', name: 'X', message: 'ReferenceError: y is not defined' })).toMatchObject({ kind: 'error', blocks: true, key: 'mesh.plugin.crashed', values: { plugin: 'X', message: 'ReferenceError: y is not defined' }, actions: [{ key: 'fix.switchOnAgain', command: 'switch_on' }, { key: 'fix.managePlugins', command: 'manage_plugins' }] })
    expect(describeProblem('plugin.disabled', { plugin: 'org.x', reason: 'boom', crashed: true })).toMatchObject({ key: 'mesh.plugin.disabled', values: { plugin: 'org.x', message: 'boom' } })
    expect(describeProblem('plugin.disabled', { plugin: 'org.x', reason: '', crashed: false }).key).toBe('mesh.plugin.off')
  })
})

describe('the channel decides for codes the app does not know (a third-party plugin)', () => {
  it('a code from the warnings list is a warning and does not block; the same code thrown is an error', () => {
    expect(describeProblem('lithophane.thin_image', {}, { channel: 'warning' })).toMatchObject({ kind: 'warning', blocks: false, key: 'mesh.lithophane.thin_image' })
    expect(describeProblem('lithophane.thin_image', {}, { channel: 'error' })).toMatchObject({ kind: 'error', blocks: true })
    expect(describeProblem('lithophane.thin_image')).toMatchObject({ kind: 'error', blocks: true })
  })
  it('built-in info codes stay info on the warning channel, and built-in warnings stay warnings on the error channel', () => {
    expect(describeProblem('emboss.text_scaled_to_fit', {}, { channel: 'warning' })).toMatchObject({ kind: 'info', blocks: false })
    expect(describeProblem('emboss.text_small', {}, { channel: 'error' })).toMatchObject({ kind: 'warning', blocks: false })
  })
})

describe('a plugin\'s own problem codes', () => {
  it('pass the plugin\'s text and number values to its text, so {{line}} and {{stroke}} are filled in', () => {
    const v = describeProblem('cookie.thin_strokes', { line: 'name', stroke: 0.4, line_width: 1.2, gap: 0.8, nested: { a: 1 }, flag: true }, { channel: 'warning' })
    expect(v.key).toBe('mesh.cookie.thin_strokes')
    expect(v.values).toEqual({ line: 'name', stroke: 0.4, line_width: 1.2, gap: 0.8 })   // objects and booleans are not text
    expect(v.kind).toBe('warning'); expect(v.blocks).toBe(false)
  })
  it('do not overwrite what a built-in code has worked out', () => {
    expect(describeProblem('emboss.text_small', { size: 0.5, mm: 99 }).values['mm']).toBe(0.5)
  })
})

describe('the store\'s problems', () => {
  it('say the budget in megabytes, the kinds the way people say them, and the name of the item', () => {
    const b = describeProblem('budget.store_bytes', { bytes: 10_900_000, max: 10_485_760 })
    expect(b.key).toBe('mesh.budget.store_bytes'); expect(b.values).toEqual({ size: '10.4 MB', max: '10 MB' }); expect(b.blocks).toBe(true); expect(b.actions.map(a => a.command)).toEqual(['open_stored'])
    const w = describeProblem('input.wrong_kind', { name: 'logo', expected: 'drawing', got: 'mesh' })
    expect(w.values).toEqual({ name: 'logo', expected: 'drawing', got: 'model' })
    const miss = describeProblem('input.missing_payload', { name: 'logo', op: 'emboss_svg', param: 'shape', kind: 'drawing' })
    expect(miss.values['name']).toBe('logo'); expect(miss.actions.map(a => a.command)).toEqual(['choose_drawing', 'import_svg'])
    expect(describeProblem('store.name_taken', { name: 'logo', op: 'store' }).values['name']).toBe('logo')
  })
})

describe('the placement problem', () => {
  it('says "drawing" for a drawing and "text" for text', () => {
    expect(describeProblem('emboss.no_placement', {}).key).toBe('mesh.emboss.no_placement')
    expect(describeProblem('emboss.no_placement', { svg: true }).key).toBe('mesh.emboss.no_placement_svg')
  })
})
