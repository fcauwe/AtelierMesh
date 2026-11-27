# Contract cheat sheet (one page, for a coding agent that cannot run anything)

If you can only write files, this page is enough to write a **correct** plugin. The longer reference is [`plugin-guide.md`](plugin-guide.md); a full example is [`../examples/plugins/mirror-plain/main.js`](../examples/plugins/mirror-plain/main.js).

## The two files
`manifest.json`
```json
{ "manifest_version": 1, "id": "com.example.shift", "name": "Shift", "version": "0.1.0", "author": "You", "license": "MIT",
  "description": "Shifts a model by x, y and z millimetres.",            // 10 to 300 characters of plain text
  "contact": { "name": "You", "url": "https://example.org", "email": "you@example.org" },   // optional, https only; never invent
  "package_url": "https://example.org/shift-0.1.0.amplugin",                // optional: where the packed file will be published
  "image": { "file": "assets/example.png", "alt": "A box moved to the right" },   // optional: gallery picture in assets/; PNG, JPEG or WebP, max 300 KB, 200-1600 px wide, max 1200 px high (640 x 420 is good)
  "operations": [ { "id": "shift", "title": "Shift", "kind": "modifier", "category": "shape", "personalisable": "never",
    "stages": ["shift"], "outputs": { "mesh": true, "report": true, "closed": true },
    "params": [ { "name": "x", "type": "float", "default": 0, "min": -1000, "max": 1000, "step": 0.5, "unit": "mm" } ] } ] }
```
- `id`: lowercase, dots, like `com.example.name`. `version`: `1.2.3`. Operation `id` and setting `name`: lowercase letters, digits, underscores.
- `kind`: `modifier` (mesh in, mesh out), `generator` (no mesh in), `analyzer` (mesh in, only a report out), `exporter`.
- `category` (menu group): `prepare`, `shape` (basic shape changes), `style` (artistic restyling), `surface`, `check`, or another lowercase id. `personalisable`: `never` (use this unless told otherwise). `importance`: `low` puts a rarely used step in the menu's "More" group. Manifest `icon`: a plugin with three or more operations in one group becomes one submenu row. An `enum` option may be `{ "value": "x", "shape": "M12 3v18…" }`: `shape` is the `d` of an SVG path on a 24 × 24 grid (a one-colour outline; path data only, at most 1000 characters), shown on the choice; more than four such choices are cards at 48 px (`examples/plugins/mirror-full`).
- `outputs.closed: true` = "a closed solid in gives a closed solid out" (the engine checks it). Declare removed labels: `"drops": ["segments"]`.
- Setting types: `float`, `int` (`default`, `min`, `max`, `step`, `unit`), `bool`, `string`, `enum` (`options`: `["a","b"]`, default is one of them), `vector` (`size` 2 or 3), `angle`, `range`, `color`, `part`, `asset`, `payload` (`accept: ["drawing"]`: a stored drawing or mesh by name, read as `ctx.payloads.<param>`), `placement`. Every number gets `min` and `max`: they are real limits. Show a setting only sometimes: `"visible_if": "mode == 'copy'"`. Group settings: `"sections": [{"id":"plane","title":"Plane"}]` and `"section":"plane"`.
- Texts live in `locales/en.json|nl.json|fr.json` (same keys in all three, UK English). The host reads them from the package, but only keys `ops.<your op>.…`, `step.op.<your op>` and `mesh.<your op or last part of your id>.…` (at most 8 files of 64 KB; plain strings with `{{placeholders}}`, no markup).

## The run function
`main.js`: one ES module, **no imports**, default export with `run(op, ctx)`.

| `ctx` | |
|---|---|
| `ctx.mesh` | `{ positions: Float64Array (x,y,z per vertex), indices: Uint32Array (3 per triangle), segments?: { labels: Uint16Array (one per triangle), table: [{ id, name }] }, groups?: [{ start, count, role: 'solid'|'negative', name? }] }`. Millimetres, Z up, counter-clockwise from outside. **Never change it.** Absent for a generator. |
| `ctx.params` | the settings, already validated, defaults filled |
| `ctx.payloads` | stored items asked for by `payload` settings, by setting name: `ctx.payloads.shape` is a drawing `{ kind: 'drawing', paths: [{ points: [[x, y], ...], closed }] }` (mm, y up), read only. `{}` when the step has none. An operation that takes or returns a drawing says `"payload": { "in": "drawing", "out": "mesh" }`; the previous step's result is `ctx.payload` (`ctx.mesh` when it is a mesh) and a drawing goes back as `{ payload }`. |
| `ctx.signal` | `ctx.signal.aborted` is true when the user cancelled: check it in loops |
| `ctx.progress(stage, fraction)` | stage is one of the manifest's `stages`; fraction 0 to 1 |
| `ctx.log(level, text)` | optional |
| `await ctx.fonts.outline(fontId, text, { size, weight?, letterSpacing?, lineSpacing?, align?, maxWidth?, tolerance?, anchor? })` | letters as polygons: `{ contours: [[[x, y], ...]] (mm, y up, outer counter-clockwise, holes clockwise), bbox: [x0, y0, x1, y1], fillRule: 'nonzero' }`. Put `"uses": ["fonts"]` in the manifest and a font as an `asset` parameter (`"widget": "font"`, `"accept": ["font"]`); `fontId` is that parameter. Errors: `emboss.missing_glyphs` (`params.characters`), `emboss.empty_text`, `emboss.text_too_long`, `fonts.unavailable`. Example: `examples/plugins/nameplate-plain/main.js`. |

Return `{ mesh, report?, warnings? }`: `mesh` as above (new arrays), `report` a plain object of numbers (shown to the designer), `warnings` a list of `{ code, params }` for a usable result that needs a look (shown as a warning, never blocks; a thrown problem is an error). An analyzer returns `{ report }` only.

## Problems
- Expected problem: `throw { code: 'myplugin.too_thin', params: { thickness: 0.2, min: 0.4 } }` (a **plain object**, the code starts with your plugin's prefix, numbers in `params`).
- Cancelled: `throw { code: 'run.cancelled', params: {} }`. No mesh given: `{ code: 'input.missing_mesh', params: {} }`. Wrong operation id: `{ code: 'step.unknown_op', params: { op } }`.
- Never throw an `Error` or let a bug escape: it counts as a crash and the host switches the plugin off. Settings outside their limits are refused by the engine before `run` (`param.out_of_range`), you need no code for that.

## Rules that make it correct
Deterministic (no `Math.random`, `Date`, network, `eval`, hidden state); same input, same output. Closed in, closed out. Winding outward (a mirror swaps two corners per triangle). Keep `segments` and `groups` valid (labels one per triangle; group ranges inside the mesh). Check `ctx.signal.aborted` every few thousand loop steps. No materials, no prices.

## Colour in three lines
Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.
```js
const labels = new Uint16Array(nt); for (const t of tris) labels[t] = 1                       // label the triangles
out.segments = { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'text', color: '#e5484d' }] }   // a segment with a colour (#rrggbb)
out.groups = mesh.groups.map(g => ({ ...g, color: '#30a46c' }))                           // or colour the bodies; `{ ...g }` keeps the colour it had
```

## A complete plugin (about 40 lines)
```js
const problem = (code, params = {}) => ({ code, params })
export default {
  async run(op, ctx) {
    if (op !== 'shift') throw problem('step.unknown_op', { op })
    const mesh = ctx.mesh
    if (!mesh) throw problem('input.missing_mesh', { op })
    if (mesh.indices.length === 0) throw problem('shift.empty')
    ctx.progress('shift', 0)
    const d = [ctx.params.x, ctx.params.y, ctx.params.z]
    const positions = new Float64Array(mesh.positions.length)
    for (let i = 0; i < positions.length; i++) {
      if ((i & 0xffff) === 0 && ctx.signal.aborted) throw problem('run.cancelled')
      positions[i] = mesh.positions[i] + d[i % 3]
    }
    ctx.progress('shift', 1)
    const out = { positions, indices: mesh.indices }
    if (mesh.segments) out.segments = mesh.segments
    if (mesh.groups) out.groups = mesh.groups
    return { mesh: out, report: { moved: d } }
  },
}
```
(with the manifest above, plus `y` and `z` settings).

## Before you hand it over
Read your two files against this page and [`NO-NPM.md`](NO-NPM.md). Say plainly what you could **not** run. Ask the person to run `node tools/amplugin.mjs check <folder>` where Node exists.
