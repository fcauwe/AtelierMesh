// Turns an engine code and its details into what a page shows: the text key, the numbers for its placeholders, how serious it is, and the
// buttons that offer a way out. It holds no text: the host looks the keys up in its own language files (i18next in the Atelier).
// Keys follow the engine codes: `mesh.<code>`; button labels are `fix.<name>`.
export type ProblemKind = 'error' | 'warning' | 'info'

export interface ProblemAction {
  /** Label key, for example `fix.makeFit`. */
  key: string
  values: Record<string, string | number>
  /** What the button changes on the text step (parameter names of the emboss operation), or a page command. */
  set?: Record<string, string | number>
  command?: 'move_to_centre' | 'turn' | 'place_again' | 'choose_font' | 'edit_text' | 'try_again' | 'contact' | 'choose_file' | 'reset_position' | 'reload' | 'switch_off' | 'switch_on' | 'manage_plugins' | 'choose_drawing' | 'import_svg' | 'open_stored'
}

export interface ProblemView {
  code: string
  key: string
  values: Record<string, string | number>
  kind: ProblemKind
  /** True when the result is not usable: the page keeps the last good result and disables saving. */
  blocks: boolean
  actions: ProblemAction[]
}

const WARNINGS = new Set(['deform.wave_too_big', 'printcheck.not_closed', 'printcheck.islands', 'printcheck.thin_walls', 'printcheck.thin_features', 'printcheck.narrow_gaps', 'printcheck.needs_support', 'printcheck.long_bridges', 'printcheck.floating_body', 'printcheck.island', 'printcheck.overhang', 'printcheck.bridge', 'printcheck.tiny_base', 'printcheck.too_tall', 'printcheck.too_big_for_bed', 'cheese.thin_walls', 'cheese.too_many_holes', 'cheese.selection_too_small', 'cheese.holes_too_big', 'hollow.thin_walls', 'hollow.thickness_too_big', 'emboss.text_small', 'emboss.thin_strokes', 'emboss.stretch', 'lowpoly.already_smaller', 'lowpoly.target_not_reached', 'lowpoly.volume_changed', 'voronoi.thin_lines', 'voronoi_shell.thin_ribs', 'voronoi_shell.thin_wall', 'voronoi_shell.thickness_too_big', 'deform.may_fold', 'smooth.thin_features', 'repair.still_open', 'repair.hole_too_big', 'repair.hole_skipped', 'parts.result_open', 'parts.cap_skipped', 'texture.may_self_intersect'])
const INFOS = new Set(['hollow.outer_remeshed', 'emboss.text_scaled_to_fit', 'placement.limits_changed', 'run.cancelled'])
/** The page clamps these before sending, so a customer should not meet them as errors: if they arrive, they are a warning. */
const CLAMPED = new Set(['placement.too_far', 'placement.size_out_of_range', 'placement.direction_out_of_range'])

type P = Record<string, unknown>
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const round1 = (v: number): number => Math.round(v * 10) / 10
const pct = (ratio: number): number => Math.round((ratio - 1) * 100)

/**
 * Where a problem came from. A step reports a `warning` in the `warnings` list of its run result and throws an `error`. The channel decides for a code that is
 * not one of the built-in codes: anything from the warnings list is a non-blocking warning (a plugin cannot be expected to be in a fixed list), anything
 * thrown stays an error. Absent: the code alone decides (unknown codes are errors).
 */
export interface DescribeOptions { channel?: 'warning' | 'error' }

export function describeProblem(code: string, params: P = {}, opts: DescribeOptions = {}): ProblemView {
  const values: Record<string, string | number> = {}
  const actions: ProblemAction[] = []
  const fit = num(params['fit_size'])
  // the numbers of a print check finding go into its text as they are (rounded)
  if (code.startsWith('printcheck.')) for (const [k, v] of Object.entries(params)) { if (typeof v === 'number' && Number.isFinite(v)) values[k] = Math.round(v * 100) / 100; else if (typeof v === 'string') values[k] = v }
  const smaller = (): void => { actions.push(fit !== undefined ? { key: 'fix.makeFit', values: { fit_size: fit }, set: { size: fit } } : { key: 'fix.makeSmaller', values: {} }) }
  let key = `mesh.${code}`

  switch (code) {
    // the advice to turn the model comes with its own text (it has the numbers of the best way up)
    case 'printcheck.island': case 'printcheck.overhang': case 'printcheck.bridge':
      if (num(params['turn']) === 1) key += '_turn'
      break
    case 'emboss.no_placement':
      if (params['svg'] === true) key += '_svg'   // a drawing, not text: its own wording
      break
    case 'emboss.touches_patch_edge':
      if (params['stopped_at_crease'] === true) key += '_crease'
      smaller(); actions.push({ key: 'fix.moveToCentre', values: {}, command: 'move_to_centre' })
      break
    case 'emboss.text_small': {
      const size = num(params['size']); if (size !== undefined) values['mm'] = round1(size)
      values['min'] = 1.5
      if (fit !== undefined) actions.push({ key: 'fix.makeBigger', values: { fit_size: fit }, set: { size: fit } })
      break
    }
    case 'emboss.thin_strokes': {
      const s = num(params['stroke']); if (s !== undefined) values['mm'] = Math.round(s * 100) / 100
      if (fit !== undefined) actions.push({ key: 'fix.makeBigger', values: { fit_size: fit }, set: { size: fit } })
      actions.push({ key: 'fix.boldFont', values: {}, command: 'choose_font' })
      break
    }
    case 'emboss.stretch': {
      const st = num(params['stretch']); if (st !== undefined) values['pct'] = pct(st)
      actions.push({ key: 'fix.moveFlatter', values: {}, command: 'place_again' }, { key: 'fix.makeSmaller', values: {} })
      break
    }
    case 'emboss.too_much_stretch': {
      const st = num(params['stretch']), lim = num(params['limit'])
      if (st !== undefined) values['pct'] = pct(st)
      if (lim !== undefined) values['max'] = pct(lim)
      actions.push({ key: 'fix.moveFlatter', values: {}, command: 'place_again' }); smaller()
      break
    }
    case 'emboss.text_scaled_to_fit': {
      const s = num(params['size']); if (s !== undefined) values['mm'] = round1(s)
      break
    }
    case 'emboss.curvature_collapse': case 'emboss.fold_over':
      actions.push({ key: 'fix.moveFlatter', values: {}, command: 'place_again' }); smaller(); break
    case 'emboss.patch_not_disk': actions.push({ key: 'fix.moveFlatter', values: {}, command: 'place_again' }); break
    case 'emboss.no_surface': case 'emboss.on_negative_body': actions.push({ key: 'fix.placeAgain', values: {}, command: 'place_again' }); break
    case 'emboss.wall_too_thin': {
      const depth = num(params['depth']), avail = num(params['available']), fh = num(params['fit_height'])
      if (depth !== undefined) values['depth'] = round1(depth)
      if (avail !== undefined) values['wall'] = round1(avail)
      actions.push({ key: 'fix.makeRaised', values: {}, set: { mode: 'raised' } })
      actions.push(fh !== undefined && fh > 0 ? { key: 'fix.engraveDepth', values: { fit_height: fh }, set: { height: fh } } : { key: 'fix.lessDeep', values: {} })
      break
    }
    case 'emboss.text_too_long': {
      const max = num(params['max']); if (max !== undefined) values['max'] = max
      actions.push({ key: 'fix.shorten', values: {}, command: 'edit_text' }, { key: 'fix.makeSmaller', values: {} })
      break
    }
    case 'emboss.missing_glyphs': {
      const chars = params['characters']; if (Array.isArray(chars)) values['characters'] = chars.join(' ')
      actions.push({ key: 'fix.otherFont', values: {}, command: 'choose_font' })
      break
    }
    case 'emboss.font_unreadable': actions.push({ key: 'fix.otherFont', values: {}, command: 'choose_font' }); break
    case 'emboss.cut_failed': actions.push({ key: 'fix.tryAgain', values: {}, command: 'try_again' }, { key: 'fix.contact', values: {}, command: 'contact' }); break
    case 'emboss.mesh_not_manifold': case 'emboss.inside_out':
      actions.push({ key: 'fix.otherFile', values: {}, command: 'choose_file' }, { key: 'fix.contact', values: {}, command: 'contact' }); break
    case 'budget.triangles': case 'budget.vertices': {
      const n = num(params['triangles'] ?? params['vertices']), max = num(params['max'])
      if (n !== undefined) values['count'] = n
      if (max !== undefined) values['max'] = max
      actions.push({ key: 'fix.otherFile', values: {}, command: 'choose_file' }, { key: 'fix.contact', values: {}, command: 'contact' })
      break
    }
    case 'placement.too_far': {
      const max = num(params['max']); if (max !== undefined) values['max'] = max
      actions.push({ key: 'fix.resetPosition', values: {}, command: 'reset_position' })
      break
    }
    case 'placement.size_out_of_range': case 'placement.direction_out_of_range': {
      const lo = num(params['min']), hi = num(params['max'])
      if (lo !== undefined) values['min'] = lo
      if (hi !== undefined) values['max'] = hi
      break
    }
    case 'run.timeout': {
      const ms = num(params['ms']); if (ms !== undefined) values['seconds'] = Math.round(ms / 1000)
      actions.push({ key: 'fix.tryAgain', values: {}, command: 'try_again' }, { key: 'fix.makeSmaller', values: {} })
      break
    }
    case 'lowpoly.already_smaller': case 'lowpoly.target_not_reached': {
      const n = num(params['triangles']), target = num(params['target'])
      if (n !== undefined) values['count'] = n
      if (target !== undefined) values['target'] = target
      break
    }
    case 'lowpoly.volume_changed': { const v = num(params['percent']); if (v !== undefined) values['pct'] = Math.abs(Math.round(v)); key += (v ?? 0) < 0 ? '_smaller' : '_larger'; break }
    case 'repair.hole_too_big': {
      const largest = num(params['largest']), max = num(params['max']), count = num(params['count'])
      if (largest !== undefined) values['largest'] = largest
      if (max !== undefined) values['max'] = max
      if (count !== undefined) values['count'] = count
      break
    }
    case 'repair.hole_skipped': case 'repair.still_open': {
      const count = num(params['count'] ?? params['holes']), edges = num(params['edges'])
      if (count !== undefined) values['count'] = count
      if (edges !== undefined) values['edges'] = edges
      break
    }
    case 'part.unknown': case 'part.ambiguous': case 'segment.unknown': case 'group.unknown': { const n = typeof params['name'] === 'string' ? params['name'] : ''; values['name'] = n; break }
    case 'parts.result_open': { const n = typeof params['part'] === 'string' ? params['part'] : ''; if (n) values['part'] = n; break }
    case 'parts.cap_skipped': { const c = num(params['count']); if (c !== undefined) values['count'] = c; break }
    case 'parts.would_remove_everything': { const n = typeof params['part'] === 'string' ? params['part'] : ''; if (n) values['part'] = n; break }
    case 'voronoi.thin_lines': {
      const w = num(params['stroke']), min = num(params['min']), line = num(params['min_line'])
      if (w !== undefined) values['width'] = Math.round(w * 100) / 100
      if (min !== undefined) values['min'] = Math.round(min * 100) / 100
      if (line !== undefined) actions.push({ key: 'fix.thickerLines', values: { line_width: line }, set: { line_width: line } })
      break
    }
    case 'voronoi.cells_too_small': case 'voronoi.too_many_cells': case 'voronoi_shell.cells_too_small': {
      const max = num(params['max_cells'] ?? params['max']), n = num(params['cells'])
      if (n !== undefined) values['cells'] = n
      if (max !== undefined) { values['max'] = max; actions.push({ key: 'fix.fewerCells', values: { max }, set: { cells: max } }) }
      break
    }
    case 'voronoi.too_heavy': {
      const n = num(params['cells']), v = num(params['vertices'])
      if (n !== undefined) { values['cells'] = n; actions.push({ key: 'fix.fewerCells', values: { max: Math.max(2, Math.floor(n / 2)) }, set: { cells: Math.max(2, Math.floor(n / 2)) } }) }
      if (v !== undefined) values['count'] = v
      break
    }
    case 'voronoi_shell.thin_ribs': case 'voronoi_shell.thin_wall': case 'hollow.thin_walls': case 'cheese.thin_walls': {
      const w = num(params['width']), min = num(params['min'])
      if (w !== undefined) values['width'] = Math.round(w * 100) / 100
      if (min !== undefined) values['min'] = Math.round(min * 100) / 100
      if (min !== undefined) actions.push({ key: code === 'voronoi_shell.thin_ribs' ? 'fix.thickerRibs' : code === 'cheese.thin_walls' ? 'fix.widerWalls' : 'fix.thickerWall', values: { width: min, thickness: min }, set: code === 'voronoi_shell.thin_ribs' ? { rib_width: min } : code === 'cheese.thin_walls' ? { min_wall: min } : { thickness: min } })
      break
    }
    case 'voronoi_shell.thickness_too_big': case 'hollow.thickness_too_big': {
      const t = num(params['thickness']), d = num(params['depth'])
      if (t !== undefined) values['thickness'] = round1(t)
      if (d !== undefined) { values['depth'] = round1(d); const fit = Math.max(0.4, Math.floor(d * 5) / 10); actions.push({ key: 'fix.thinnerWall', values: { thickness: fit }, set: { thickness: fit } }) }
      break
    }
    case 'voronoi_shell.too_heavy': case 'hollow.too_heavy': case 'cheese.too_heavy': {
      const n = num(params['cells']), tri = num(params['triangles']), lim = num(params['limit']) ?? num(params['max'])
      if (n !== undefined) values['count'] = n
      if (tri !== undefined) values['count'] = tri
      if (lim !== undefined) values['max'] = lim
      actions.push({ key: 'fix.coarserDetail', values: {}, set: { detail: 'coarse' } })
      break
    }
    case 'holes.thin_wall': {
      const w = num(params['width']), min = num(params['min']), d = num(params['depth'])
      if (w !== undefined) values['width'] = Math.round(w * 100) / 100
      if (min !== undefined) values['min'] = Math.round(min * 100) / 100
      if (w !== undefined && min !== undefined && d !== undefined) { const nd = Math.max(0.5, Math.round((d - (min - w)) * 10) / 10); actions.push({ key: 'fix.shallowerHole', values: { depth: nd }, set: { depth: nd } }) }
      break
    }
    case 'cheese.too_many_holes': {
      const r = num(params['requested']), pl = num(params['placed'])
      if (r !== undefined) values['requested'] = r
      if (pl !== undefined) { values['placed'] = pl; actions.push({ key: 'fix.fewerHoles', values: { count: Math.max(1, pl) }, set: { holes: Math.max(1, pl) } }) }
      break
    }
    case 'cheese.selection_too_small': {
      const r = num(params['requested']), pl = num(params['placed']), mx = num(params['max'])
      if (r !== undefined) values['requested'] = r
      if (typeof params['part'] === 'string') values['part'] = params['part']
      if (pl !== undefined) { values['placed'] = pl; if (pl > 0) actions.push({ key: 'fix.fewerHoles', values: { count: pl }, set: { holes: pl } }) }
      if (mx !== undefined) { values['max'] = round1(mx); actions.push({ key: 'fix.smallerHoles', values: { max: round1(mx) }, set: { max_radius: round1(mx) } }) }
      break
    }
    case 'cheese.holes_too_big': {
      const r = num(params['radius']), mx = num(params['max'])
      if (r !== undefined) values['radius'] = round1(r)
      if (mx !== undefined) { values['max'] = round1(mx); actions.push({ key: 'fix.smallerHoles', values: { max: round1(mx) }, set: { max_radius: round1(mx) } }) }
      break
    }
    case 'smooth.thin_features': {
      const ch = num(params['change']), mv = num(params['move'])
      if (ch !== undefined) values['change'] = round1(ch)
      if (mv !== undefined) values['move'] = Math.round(mv * 100) / 100
      break
    }
    case 'deform.may_fold': {
      const at = num(params['at']), st = num(params['stretch']), sc = num(params['scale'])
      if (at !== undefined) values['at'] = Math.round(at)
      if (st !== undefined) values['stretch'] = round1(st)
      if (sc !== undefined) values['pct'] = Math.round(sc * 100)
      break
    }
    case 'deform.wave_too_big': {
      const am = num(params['amplitude']), sd = num(params['side'])
      if (am !== undefined) values['amplitude'] = round1(am)
      if (sd !== undefined) values['side'] = round1(sd)
      break
    }
    case 'deform.too_heavy': {
      const n = num(params['triangles']), lim = num(params['limit'])
      if (n !== undefined) values['count'] = n
      if (lim !== undefined) values['max'] = lim
      actions.push({ key: 'fix.coarserDetail', values: {}, set: { detail: 'coarse' } })
      break
    }
    case 'texture.too_heavy': {
      const n = num(params['triangles']), lim = num(params['limit']), e = num(params['edge'])
      if (n !== undefined) values['count'] = n
      if (lim !== undefined) values['max'] = lim
      if (e !== undefined) values['edge'] = e
      actions.push({ key: 'fix.coarserDetail', values: {}, set: { detail: 'coarse' } })
      break
    }
    case 'texture.may_self_intersect': {
      const a = num(params['amplitude']), n = num(params['turned']), t = num(params['tight'])
      if (a !== undefined) values['amplitude'] = round1(a)
      if (n !== undefined) values['turned'] = n
      if (t !== undefined) values['tight'] = t
      break
    }
    case 'deform.folds': { const at = num(params['at']); if (at !== undefined) values['at'] = Math.round(at * 100); break }
    case 'voronoi.does_not_fit': actions.push({ key: 'fix.moveFlatter', values: {}, command: 'place_again' }, { key: 'fix.makeSmaller', values: {} }); break
    case 'step.unknown_plugin': {
      // the project needs a plugin this browser does not have: the way out is the plugin manager (install the file again)
      const pl = params['plugin']; if (typeof pl === 'string') values['plugin'] = pl
      actions.push({ key: 'fix.openPluginManager', values: {}, command: 'manage_plugins' })
      break
    }
    case 'step.version_newer': actions.push({ key: 'fix.reload', values: {}, command: 'reload' }); break
    case 'apply.step_failed': {
      key = 'mesh.apply.failed'
      const st = params['step']; if (typeof st === 'string') values['step'] = st
      actions.push({ key: 'fix.tryAgain', values: {}, command: 'try_again' })
      break
    }
    case 'plugin.crashed': case 'plugin.disabled': {
      // the plugin's name for the people, its id as a fallback; `message` is the first line of what was thrown
      const name = params['name'] ?? params['plugin']; if (typeof name === 'string') values['plugin'] = name
      const msg = params['message'] ?? params['reason']; values['message'] = typeof msg === 'string' ? msg : ''
      if (code === 'plugin.disabled' && params['crashed'] !== true) key = 'mesh.plugin.off'   // switched off by hand, not by a crash
      actions.push({ key: 'fix.switchOnAgain', values: {}, command: 'switch_on' }, { key: 'fix.managePlugins', values: {}, command: 'manage_plugins' })
      break
    }
    case 'plugin.failed': case 'plugin.bad_mesh': {
      const pl = params['plugin']; if (typeof pl === 'string') values['plugin'] = pl
      actions.push({ key: 'fix.switchOff', values: {}, command: 'switch_off' })
      break
    }
    case 'budget.store_bytes': {
      // the sizes in megabytes, the way the store screens show them
      const mbText = (n: number | undefined): string => `${(Math.round(((n ?? 0) / 1048576) * 10) / 10).toLocaleString('en-US')} MB`
      values['size'] = mbText(num(params['bytes'])); values['max'] = mbText(num(params['max']))
      actions.push({ key: 'store.openStored', values: {}, command: 'open_stored' })
      break
    }
    case 'budget.store_entries':
      for (const k of ['entries', 'max']) { const n = num(params[k]); if (n !== undefined) values[k] = n }
      actions.push({ key: 'store.openStored', values: {}, command: 'open_stored' })
      break
    // a step that needs a stored item that is not there: choose another, or import it again
    case 'input.missing_payload':
      if (typeof params['name'] === 'string') values['name'] = params['name']
      actions.push({ key: 'store.chooseDrawing', values: {}, command: 'choose_drawing' }, { key: 'store.import', values: {}, command: 'import_svg' })
      break
    case 'emboss.no_shape':
      actions.push({ key: 'store.chooseDrawing', values: {}, command: 'choose_drawing' })
      break
    case 'store.bad_entry':
      for (const k of ['name', 'problem']) { const v = params[k]; if (typeof v === 'string') values[k] = v }
      actions.push({ key: 'store.replace', values: {}, command: 'open_stored' })
      break
    case 'input.wrong_kind': {
      // the kinds as people say them: a mesh is a model
      const say = (k: unknown): string => (k === 'mesh' ? 'model' : typeof k === 'string' ? k : '')
      values['expected'] = say(params['expected']); values['got'] = say(params['got'])
      if (typeof params['name'] === 'string') values['name'] = params['name']
      actions.push({ key: 'store.chooseDrawing', values: {}, command: 'choose_drawing' })
      break
    }
    default:
      // a code this list does not know (a plugin's own: `cookie.thin_strokes`) has its text in the plugin's locale files, with the names the plugin gave its values
      // (`{{line}}`, `{{stroke}}`): pass the text and number values on, or the person reads the placeholders
      for (const [k, v] of Object.entries(params)) {
        if (k in values) continue
        if (typeof v === 'string') values[k] = v
        else if (typeof v === 'number' && Number.isFinite(v)) values[k] = v
      }
      break
  }
  const kind: ProblemKind = INFOS.has(code) ? 'info' : WARNINGS.has(code) || CLAMPED.has(code) || opts.channel === 'warning' ? 'warning' : 'error'
  return { code, key, values, kind, blocks: kind === 'error', actions }
}

/** The text key of the stage label for `onProgress(stepId, stage, fraction)`; unknown stages say "Working…". */
export const stageKey = (stage: string): string => (['text', 'pattern', 'unfold', 'cut', 'collapse', 'crystallise', 'auto_orient', 'overhang', 'resize', 'rotate', 'weld', 'manifold', 'islands', 'parts', 'holes', 'place', 'field', 'surface', 'cavity', 'hole_cut', 'hole_wall', 'subdivide', 'displace', 'deform', 'smooth', 'printcheck'].includes(stage) ? `work.${stage}` : 'work.other')
