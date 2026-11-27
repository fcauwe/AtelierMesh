# Build a plugin for AtelierMesh

For a developer, or a coding agent, who has never seen this repository. It takes you from nothing to a plugin that is tested, packaged, loaded in the standalone app and ready to be handed to a host such as the Atelier. Everything in it was run: the example in section 14 is in `examples/plugins/mirror-full`, built and tested from the packed tarballs in a clean folder.

**If you were given the plugin kit** (a zip called `ateliermesh-plugin-kit-<version>.zip`, also downloadable from the app: Settings, Plugins, *Build your own plugin*), open `README-START-HERE.md` in it first: every file this guide names is in the kit, and every command works from the unzipped folder. **If you work in the AtelierMesh repository**, the same files are in the repository; section 17 and the right-hand column of the table below are yours.

Reading order: this guide first. Then the exact interfaces in [`plugin-authoring.md`](plugin-authoring.md), the format and rules in [`SPEC.md`](../SPEC.md) (sections 4 to 6, 8 and 5A; in the kit this is `spec/SPEC-plugins.md`) and how packages load in [`external-plugins.md`](external-plugins.md). A ready-made prompt for your coding agent is [`prompt-make-a-plugin.md`](prompt-make-a-plugin.md).

## Two ways to work: outside the repository (the kit) or inside the repository

| | **Outside the repository: the plugin kit** | **Inside the repository** |
|---|---|---|
| What you have | The unzipped kit: `README-START-HERE.md`, `docs/`, `spec/SPEC-plugins.md`, `examples/plugins/mirror-full` (the complete source), `packages/*.tgz`, `types/`, `tools/amplugin.mjs` | The whole repository |
| This guide | `docs/plugin-guide.md` | `docs/plugin-guide.md` |
| The specification | `spec/SPEC-plugins.md` (sections 1 to 6, 8 and 11 of `SPEC.md`, unchanged) | `SPEC.md` |
| The example | `examples/plugins/mirror-full` (copy it and keep the folder depth) | the same path |
| The engine and its types | `npm install ./packages/ateliermesh-core-<version>.tgz` (the example already depends on it), or read `types/core/` | `packages/core/src`, packed with `npm run pack` |
| Install the example | `cd examples/plugins/mirror-full && npm install` | copy the folder out (section 2) and `npm install` there |
| Check it | `npm run typecheck` and `npm test` in the example | the same, and `npm run check`, `npm run check:packages` for a built-in plugin |
| Pack it | `npm run pack` in the example, or `node tools/amplugin.mjs pack <folder>` from the kit root | `node packages/loader/bin/amplugin.mjs pack <folder>` |
| Try it | the standalone app: open it, **Plugins…**, **Choose a plugin file** | `npm run build:standalone`, serve `apps/standalone/dist` |
| Where the texts go | `locales/en.json`, `nl.json`, `fr.json` of your plugin; the host merges them from the package (own namespace only, see section 9) | the same for an external package; for a built-in plugin `apps/standalone/src/locales/` |
| Where a built-in plugin lives | not applicable (you make an external package) | `packages/plugins/src` (section 17) |

> **No npm?** See the next section: three ways to work with only Node, only Python 3, or only a shell.

> **The npm package called `amplugin` is not ours.** Nothing of AtelierMesh is published on npm. The packing tool is `tools/amplugin.mjs` in the kit (and `packages/loader/bin/amplugin.mjs` in the repository). Do not `npm install amplugin`.

## No npm? Three ways

If your coding agent or machine has **no npm** (no network, no package installs, no TypeScript), you can still build, test and pack a plugin. A plugin is two plain files, `manifest.json` and a one-file, import-free `main.js`. Pick the first tier that fits; the full instructions are in [`NO-NPM.md`](NO-NPM.md) and a one-page reference for an agent that cannot run anything is [`CONTRACT-CHEATSHEET.md`](CONTRACT-CHEATSHEET.md).

| Tier | You have | Test | Pack |
|---|---|---|---|
| **A** | Node 20+, no npm | `node tools/amplugin.mjs check <folder>` (the complete test) and `node tools/amplugin.mjs run <folder> --input generator:box ...` | `node tools/amplugin.mjs pack <folder>` |
| **B** | Python 3, no Node | `python3 tools/amplugin_check.py <folder>` (static checks only: it cannot run the plugin) | `python3 tools/amplugin_pack.py <folder>` (the same package, unsigned) |
| **C** | a shell or only an editor | by reading, with the checklist in `NO-NPM.md` | `sha256sum` and `zip` by hand (exact recipe in `NO-NPM.md`) |

The template is [`examples/plugins/mirror-plain`](../examples/plugins/mirror-plain/main.js): the Mirror plugin of section 14 as one plain JavaScript file with `fixtures.json` and texts. `node tools/amplugin.mjs new my-plugin` writes a smaller one. The rules for a plain JavaScript plugin (no imports, throw `{ code, params }` objects instead of `new MeshError`, check `ctx.signal.aborted`, keep the labels) are listed at the top of `NO-NPM.md`; sections 3 to 13 of this guide apply unchanged (the manifest, the run contract, parts, texts, tests).

## 1. What a plugin is

A plugin is a **manifest** (JSON that describes its operations and their parameters) plus a **module** (code with one `run` function). A host such as the standalone app or the Atelier reads the manifest, draws the settings panel from it, and calls `run` with the mesh from the step before. You write no user interface.

| A plugin can | A plugin cannot |
|---|---|
| Take a mesh in and give a mesh out (a `modifier`), make one from nothing (a `generator`), or only measure it and report (an `analyzer`) | Know about materials, filaments, prices, precision or infill. Those belong to the host. |
| Add or change **segments** (labelled parts of the surface) and keep **groups** (separate bodies) | Draw its own panel, call the network, read files, use the clock or random numbers (section 8) |
| Say which of its settings a designer may hand to a customer (section 11) | Change the mesh it receives (it returns a new one) |
| Report numbers (`report`) and problems (`warnings`, or an error with a code) | Return something that is not a valid mesh: numbers must be finite, indices in range, within the triangle budget |

The mesh: `positions` (Float64Array, x y z per vertex, **millimetres**, **Z up**, right-handed), `indices` (Uint32Array, three per triangle, **counter-clockwise seen from outside**), optional `segments` and `groups`. Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export. There is nothing else to read colour from: a plugin cannot copy colour from a textured model. A result that should be a printable part must be a **closed solid**: every edge shared by exactly two triangles.

**The licence of your plugin is yours.** AtelierMesh itself is dual licensed (AGPL-3.0-or-later by default, other licences on request), but the kit (this guide, the templates, the Mirror example, the packing tool) is MIT, and the AGPL has an additional permission that lets you bundle the Plugin Interface (`MeshError`, the types and the helpers this guide names) into a plugin and license it as you like. Say which licence in the manifest (`license`). See `LICENSING.md`.

## 2. The ten-minute path

You need Node 20 or newer (the repository itself uses Node 24) and the packed AtelierMesh core package (`ateliermesh-core-0.2.4.tgz`; the other packages are for hosts). Nothing of AtelierMesh is published on npm: the packages come in the kit's `packages/` folder, or from `npm run pack` in the repository.

**Outside the repository (the kit).** Unzip the kit, then:

```
cd examples/plugins/mirror-full
npm install                           # the packed core package, TypeScript, vitest and esbuild (the network is needed once)
npm run typecheck
npm test                              # the plugin runs inside the real engine, with fixtures
npm run pack                          # dist/com.example.mirror-1.0.0.amplugin (about 6 KB), made by ../../../tools/amplugin.mjs
npm run inspect                       # id, hash, signer, files
```

**Inside the repository.**

```
npm install
npm run pack                          # builds build/tarballs/*.tgz
cp -r examples/plugins/mirror-full /tmp/my-plugin && mkdir /tmp/tarballs && cp build/tarballs/*.tgz /tmp/tarballs/
cd /tmp/my-plugin
npm install && npm run typecheck && npm test
mkdir -p tools && cp <repo>/packages/loader/bin/amplugin.mjs tools/ && node tools/amplugin.mjs pack . --out dist/com.example.mirror-1.0.0.amplugin
```

(The example's own `package.json` is written for the repository copy-out: its `pack` script uses `tools/amplugin.mjs` next to it. The kit's copy points at `../../../tools/amplugin.mjs`.)

Load it in the standalone app (the hosted one, or `npm run build:standalone` and serve `apps/standalone/dist`): open a sample, **Add a step**, **Plugins…**, **Choose a plugin file**, approve the dialog. The operation appears in the **Add a step** menu under its category, and its settings are drawn from the manifest. An unsigned package is labelled **Unsigned**; a package signed with a key you have not trusted is refused (section 13).

Bigger real examples to read (**repository only**: these source files are not in the kit; the kit has their public types in `types/plugins/`), all in `packages/plugins/src`: `printcheck.ts` (an analyzer: sampling a surface with rays from the BVH of `@ateliermesh/core`, findings with severities, a score and flagged triangle runs; the plugin only reports, the host draws the card), `deform.ts` (the exact closed-form maps twist, taper and bend on a mesh cut by planes) and `deform-field.ts` (a displacement field, wave and ripple, with conforming edge splitting in rounds), `holes.ts` (an exact local boolean subtract of a convex cutter from a closed mesh, rebuilding only the touched triangles), `cheese.ts` (a conforming cut of a surface mesh by spheres: local subdivision at edge midpoints, vertices placed exactly on the spheres, and caps that start from the cut loop, so the rest of the surface is kept bit for bit), `hollow.ts` + `implicit/iso.ts` (a second user of the signed-distance field and marching tetrahedra, with a hierarchical narrow band and the outer surface of the input kept untouched), `voronoi*.ts` (two operations in one plugin; `voronoi/shell.ts` is a complete implicit-surface pipeline: signed distance, a Voronoi field, marching tetrahedra, with progress and cancellation in every long loop), `texture.ts` + `texture/patterns.ts` (a displacement texture: per-edge conforming subdivision, vertex weights from a shortest-path distance, procedural tileable patterns and a small PNG decoder for a picture asset), `deform*.ts` (a smooth map with adaptive subdivision) and `smooth.ts` in it (a vertex filter that leaves the triangles alone: the smallest kind of mesh operation), `repair*.ts` (mesh surgery that keeps groups and segments) and `lowpoly*.ts` (reusing the decimation engine).

Starting your own: copy `examples/plugins/mirror-full` (in the kit, keep its folder depth, or fix the `../../../` paths in its `package.json`), change the id in `manifest.json` (reverse-domain, lower case: `com.yourname.thing`), rename the operation, replace `src/mirror.ts`. Keep the tests: they are your safety net.

## 3. The manifest

```json
{
  "manifest_version": 1,
  "id": "com.example.mirror",
  "name": "Mirror",
  "version": "1.0.0",
  "author": "Example Ltd",
  "license": "MIT",
  "description": "Mirrors a model along an axis, in place or as a copy beside it.",
  "contact": { "name": "Example Ltd", "url": "https://example.org/plugins", "email": "plugins@example.org" },
  "package_url": "https://example.org/plugins/com.example.mirror-1.0.0.amplugin",
  "image": { "file": "assets/example.png", "alt": "A bracket mirrored along its length, the copy in grey beside it" },
  "operations": [ { "id": "mirror", "title": "Mirror", "kind": "modifier", "params": [] } ]
}
```

`validateManifest(manifest)` returns `{ ok, errors }`; a plugin with an invalid manifest is refused. Errors are `{ code: 'manifest.invalid', params: { reason, ... }, path }`, for example `bad_plugin_id`, `bad_default` and `unknown_param_type` (all checked).

**Top level.** `id` (reverse-domain, lower case), `name`, `version` (semver; raise it when behaviour changes), `author`, `permissions` (default none), `uses` (host services you call: `["fonts"]`), `limits`.

**Metadata (required and optional).** The host shows these to a person who is deciding whether to add your plugin, so a package without the first two is refused with a readable message:

| Field | Required | Rule |
| --- | --- | --- |
| `license` | yes | An SPDX identifier (`MIT`, `Apache-2.0`, `GPL-3.0-only`) or `Proprietary`: 1 to 64 characters of letters, digits and `. + -` and spaces. Permissive for anything you ship with it. |
| `description` | yes | Plain text, 10 to 300 characters, no line breaks. What the plugin does, in a sentence or two. It is always shown as text, never as markup. |
| `contact` | no | `{ "url": "https://...", "email": "you@example.org", "name": "You" }`. Every field is optional; `url` must be https with no user name or password (at most 200 characters), `name` at most 80. The host links `url` (new tab, no referrer) and builds a mail link from `email`. Nothing else is allowed in it. |
| `package_url` | no | The https address where the packed `.amplugin` is published (at most 300 characters, no credentials). With it the plugin manager can offer **Check for update** (only when the person clicks: nothing is fetched by itself). The new file is read, compared by version, and the person is asked before it replaces the old one; a package with another `id` is refused. Your server must allow cross-origin reads (`Access-Control-Allow-Origin: *`), or the person has to download the file and choose it. |
| `replaces` | no | Only when you change a plugin's `id`: the old ids, up to 8 (`["com.example.old_mirror"]`). A design saved with an old id then runs with this plugin, its settings go through your `migrate` (which gets the old version), and the host can tell people which plugin replaces a missing one. Your new `version` must be higher than the highest old one. Change an id only when you have to: every design has it inside. |
| `image` | no | An example picture for the plugin gallery: `{ "file": "assets/example.png", "alt": "what it shows" }`. Put the file in your `assets/` folder; `file` is its path inside the package (no `..`, no leading slash). PNG, JPEG or WebP (found by content, not by name), **at most 300 KB**, between 200 and 1600 px wide and at most 1200 px high; 640 x 420 px with a transparent background looks best. `alt` is 5 to 160 characters of plain text for people who cannot see it. A package whose picture is missing, too big or not a picture is refused with a message that says why. The host shows it on your plugin's card and when it asks whether to add the plugin. |

Never invent contact details: leave `contact` out unless you have them. `amplugin check` (and the Python checker) fails on a missing licence or description and says what to write; `contact` and `package_url` only get a note when absent. Unknown extra fields are ignored; put your own under a namespaced key.

**Operation.** `id` and `title`, `kind` (`generator` needs no input, `modifier` mesh in and out, `analyzer` mesh in and a report out, `exporter`), `category`, `personalisable`, `params`, `sections`, `stages`, `outputs`, `limits`.

- **`category`** puts the operation in the host's **Add a step** menu: `prepare` (repair, clean up), `shape` (change the form), `surface` (put something on the surface), `check` (analyse, change nothing). Any other lowercase id becomes its own group; the host titles `add` "Add a part" (en, nl, fr), another id gets its name with a capital. Left out: `check` for an analyzer, `shape` otherwise. The menu order is prepare, shape, surface, check, then yours.
- **`stages`**: names for progress (`["weld", "holes"]`). Report them with `ctx.progress(stage, fraction)`.
- **`outputs`**: `{ mesh: true, report: true, closed: true }`. `closed: true` is a promise: if the input was a closed solid, so is the result, and the engine checks it (a broken promise is `plugin.bad_mesh` with `problem: "not_closed"`; checked). `segments` and `groups` name the parts you make (a name, or `{ "param": "segment" }` when a parameter names it) and `drops: ["segments"]` says what you do not carry through. The editor uses them to warn, before anything runs, that a later step names a part nobody makes.
- **`limits`**: `{ max_input_triangles, max_output_triangles, max_memory_mb }`. Say what you can take; the engine stops a result over your limit with a clear error and keeps the step before it.
- **`sections`**: `[{ "id": "plane", "title": "Plane", "collapsed": false }]`; a parameter joins one with `"section": "plane"`. (Not the mesh's groups.)

**Parameters.** Every parameter has `name` (`^[a-z][a-z0-9_]*$`, unique in its operation), `type` and a valid `default`. `min` and `max` are **hard limits**, enforced again on any server that validates, not hints. Common fields: `label`, `help`, `unit`, `section`, `visible_if`, `enabled_if`, `personalisable`, `quality`, `affects`. An unknown parameter type refuses the plugin.

| Type | Example (all validated) |
|---|---|
| `bool` | `{ "name": "enabled", "type": "bool", "default": true }` |
| `int`, `float` | `{ "name": "size", "type": "float", "default": 8, "min": 1, "max": 200, "step": 0.5, "unit": "mm" }` |
| `string` | `{ "name": "label", "type": "string", "default": "Hello", "max_length": 40, "pattern": "^[A-Za-z ]*$" }` (also `multiline`, `min_length`) |
| `enum` | `{ "name": "mode", "type": "enum", "default": "flip", "options": ["flip", "copy"] }`, or options as `{ "value": "a", "label": "Alpha" }` |
| `vector` | `{ "name": "offset", "type": "vector", "size": 3, "default": [0, 0, 0], "min": -100, "max": 100, "unit": "mm", "labels": ["x", "y", "z"] }` (shown with the axis in front of each box) |
| `angle` | `{ "name": "turn", "type": "angle", "default": 90, "min": -360, "max": 360 }` (degrees) |
| `range` | `{ "name": "band", "type": "range", "default": [10, 80], "min": 0, "max": 90, "unit": "deg" }` |
| `color` | `{ "name": "colour", "type": "color", "default": "#336699" }` (also `alpha`, `palette`, `only_palette`) |
| `asset` | `{ "name": "picture", "type": "asset", "default": null, "accept": ["image/svg+xml"], "library": "illustrations", "widget": "gallery" }` |
| `part` | `{ "name": "segment", "type": "part", "default": "", "kinds": ["segment"], "allow_empty": true }` (section 5) |
| `placement` | `{ "name": "where", "type": "placement", "default": null, "up_ref": "z", "personalisable": true }` (a spot on the surface, section 11) |
| `object` | `{ "name": "outline", "type": "object", "default": {...}, "fields": [ ...parameters ] }` (fields that belong together) |
| `list` | `{ "name": "layers", "type": "list", "default": [], "item": [ ...parameters ], "min_items": 0, "max_items": 5 }`. A row may hold a `placement`: that is how a step takes **several clicked points** (`{ "name": "spots", "type": "list", "max_items": 4, "default": [], "item": [ { "name": "at", "type": "placement", "default": null } ] }`). Each row has a button that lets the person click on the model; earlier steps that move or scale the model move every point with it, as for a single placement. A list cannot hold another list. |
| `selection` | paint on the model, see `SPEC.md` 4.5 (reserved: no host draws it yet) |

**`visible_if` and `enabled_if`** are a small safe expression over other parameters, never code: `"mode == 'copy'"`, `"enabled && count > 2"`. The host evaluates them; the engine does not validate hidden fields differently.

**How it looks (presentation hints).** Optional hints say how a field should be drawn: `widget` (`segmented`, `cards`, `slider`, `stepper`, `axes`, and `font`/`gallery` for assets; until the host draws a picture gallery, `gallery` shows a plain Choose… button that asks for a picture), `importance` (`main`, `normal`, `advanced`), `icon`, and per operation `icon` and `summary`. A host that does not know a hint shows the plain control, so they can never break a plugin. See [`plugin-authoring.md`](plugin-authoring.md), "How it looks". <!-- TODO(plugin-guide): when plugin-authoring.md has its "How it looks" section, add one line per hint with an example here. -->

## 4. The run function

```ts
import type { PluginModule } from '@ateliermesh/core'
export default {
  async run(op, ctx) { /* return { mesh?, report?, warnings? } */ },
  migrate(fromVersion, params, op) { /* optional, section 10 */ },
  migrateOp(fromVersion, op, params) { /* optional */ },
} satisfies PluginModule
```

`run` gets the operation id, so one module serves all the plugin's operations. `ctx`:

| Field | Meaning |
|---|---|
| `params` | Validated, defaults filled, inside the limits. Do not re-validate. |
| `mesh` | The mesh from the previous step. Missing for the first step of a generator. Never change it. |
| `assets(id)` | `Promise<Uint8Array>`: bytes of a font, image or file, resolved by the host. Your only way to read outside data. |
| `fonts.outline(fontId, text, options)` | `Promise<FontOutlines>`: letter outlines made by the host (see "Fonts and text"). Needs `"uses": ["fonts"]` in the manifest. |
| `quality` | `'preview'` or `'export'`. You may return a fast approximation for preview; then set `report.preview_approximate = true`. |
| `progress(stage, fraction)` | Progress, 0 to 1, with a stage named in `stages`. |
| `signal` | `AbortSignal`. Check `ctx.signal.aborted` regularly, also inside long loops, and `throw new MeshError('run.cancelled')`. A plugin that ignores it is ended after a short grace period. |
| `log(level, message)` | `info`, `warn`, `error`. |

**Result:** `mesh` (required for generators and modifiers), `report` (plain JSON: numbers, strings, booleans), `warnings` (an array of `{ code, params, where? }`). **`where`** says where on the model a warning happened, so the app can mark it: `{ "points": [[x, y, z], ...], "triangles": [n, ...] }`, in millimetres and triangle numbers of **your result**. The app shows a "Show on the model" button on that warning; it lights the triangles and puts a marker on each point (and moves the view to "up to this step" when a later step is shown). At most 64 points and 20 000 triangles; coordinates that are not finite and triangle numbers that do not exist are dropped (the warning stays).

**Problems, with a code.** Throw `new MeshError('myplugin.too_thin', { min: 0.4, found: 0.2 })`: a code with a **plugin prefix**, plus the numbers a person needs, never only a sentence. The host translates by code (section 9). Use `warnings` for a result that is usable but needs a look, and an error for one that is not. Mind this: **anything that is not a `MeshError` is a crash.** A `TypeError`, a `ReferenceError`, a failed import or a dead worker is reported as `plugin.crashed` and the engine **switches your plugin off** until the user switches it on again (checked). So catch what you can foresee and give it a code.

**Determinism.** The result depends only on `op`, `params`, `mesh`, `assets` and `quality`. The cache key is built from exactly these, so a plugin must not use `Math.random`, `Date`, the network or state kept between runs. Need randomness? Take a `seed` parameter and use your own small generator (the Voronoi plugin does). Same input, same output, bit for bit.

## 5. Parts: segments and groups

- A **segment** is a named set of triangles of one surface. `mesh.segments = { labels: Uint16Array (one per triangle), table: [{ id, name, color? }] }`. Label 0 is `body`. `color` is `#rrggbb`: segments are how a viewer and a slicer get colours.
- A **group** is a separate body: `{ start, count, role: 'solid' | 'negative', name?, color? }`, a contiguous range of **triangles** (not indices). Groups must cover the whole mesh.
- **Carry the labels through.** An operation that keeps the triangles keeps `segments`. One that creates triangles gives each new triangle the label of the triangle it came from. One that cannot must drop `segments` and say so (`outputs.drops`), never leave labels that no longer fit. If you reorder triangles, rebuild the group ranges.
- **Work on one part.** Give the operation a `part` parameter and use `selectPart(mesh, value, kinds)` from core: it returns `null` (the whole mesh) or a flag per triangle, or throws `segment.unknown`, `group.unknown` or `part.ambiguous`.
- **Name what you make.** A new segment name must match `^[a-z][a-z0-9_]*$` and be unique; reusing a name replaces the earlier segment. Make the name a parameter, as the emboss plugin does (`segment` for the top, `walls_segment` for the sides).

The worked example (section 14) mirrors a model that has segments and groups and keeps both, with their colours; its tests check it.

### Colour

Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.

- **Keep the colours you get.** Copy `mesh.segments.table` and the groups with every field (`{ ...s }`, `{ ...g }`): a rebuilt group that forgets `color` loses the colour. A segment colour wins over the colour of the body the triangle is in; the default segment `body` can carry a colour too.
- **Colour a new segment.** Give the table entry a colour when you create it (plain JavaScript, no imports):

```js
const labels = new Uint16Array(nt)                       // one label per triangle; 0 is body
for (const t of letterTriangles) labels[t] = 1
const out = { positions, indices,
  segments: { labels, table: [{ id: 0, name: 'body' }, { id: 1, name: 'letters', color: '#e5484d' }] } }
```

- **Colour a body.** Put the colour on the group: `out.groups = mesh.groups.map(g => (g.name === 'lid' ? { ...g, color: '#30a46c' } : g))`.
- **Colour by a rule** (height, face direction ...): label the triangles by the rule and give each label a colour from a short list, for example `labels[t] = nz > 0.7 ? 1 : nz < -0.7 ? 2 : 0` for up, down and side faces.
- **Only `#rrggbb`.** A colour that is not a `#` and six hex digits (`red`, `#abc`, `#ff000080`) is refused: the result is rejected with `plugin.bad_mesh`. In TypeScript the core helpers `setGroupColor(mesh, name, color)`, `setSegmentColor`, `colorSegments(mesh, { name: color })` and `assignSegment(mesh, name, flags, color)` check it for you (`segment.bad_color`).
- At most 64 colours survive a 3MF import; a plugin may see segments `material_1`, `material_2` ... for the colours of an imported file. What a 3MF export writes: [3mf-colour.md](3mf-colour.md).

## 6. Assets

A font, image or SVG is an `asset` parameter; in `run`, `await ctx.assets(id)` gives the bytes. `decodeImage` (core) turns PNG or JPEG into pixels. The cache key includes the **content** of the asset, so changing the file re-runs the step. An external package may ship files under `assets/` and read them as `ctx.assets("pkg:<plugin id>/<path>")`. WebAssembly works: ship the `.wasm` as an asset and instantiate it from the bytes.

### Fonts and text

A plugin that needs letters (a name plate, a cake topper, an SVG for a laser) does **not** read a font file itself. It asks the host:

```js
// manifest.json:  "uses": ["fonts"],  and an asset parameter  { "name": "font", "type": "asset", "widget": "font", "accept": ["font"], "default": "font:Roboto" }
const o = await ctx.fonts.outline(ctx.params.font, ctx.params.text, { size: 12, weight: 700, letterSpacing: 0.5 })
// o.contours  Array of polygons [[x, y], ...]: millimetres, y up; outer contours counter-clockwise, holes clockwise, no crossings
// o.bbox [x0, y0, x1, y1] · o.fillRule 'nonzero' (even-odd gives the same shape) · o.lines · o.size · o.fitScale
```

- **Options:** `size` (height of a capital, mm, 0.1 to 1000, required), `weight` (variable fonts, the `wght` axis), `letterSpacing` (mm after each glyph), `lineSpacing` (× size, default 1.2; `\n` starts a new line), `align` (`left`, `center`, `right`), `maxWidth` (scales the text down to fit, mm), `tolerance` (curve flattening, mm, default 0.01), `anchor` (`{ h, v }`: which point of the text's box is at the origin; default the left edge of the letters and the first baseline). Kerning and ligatures are the font's own.
- **Errors you can catch** (`e.code`): `emboss.missing_glyphs` (`e.params.characters`: the font lacks them; say which), `emboss.empty_text`, `emboss.text_too_long` (200 characters), `emboss.font_unreadable`, `fonts.bad_options` (a size that is not a number, ...), `fonts.unavailable` (the host has no font service).
- **The font id** comes from an asset parameter (`font:<Family>` in the standalone and the Atelier). The host reads the file, whatever its format (TrueType, OpenType, WOFF, WOFF2), and caches it. `ctx.assets(fontId)` still gives the raw file if you really need it, but then you must parse it yourself. A default id must exist in every host that runs your plugin; to be sure, ship a font in the package (`assets/font.ttf`) and use `pkg:<plugin id>/assets/font.ttf`.
- **A host without the service** refuses a step of a plugin with `"uses": ["fonts"]` before it starts (`plugin.needs_fonts`).
- **Test it:** `amplugin check <dir> --font file.ttf` and `amplugin run <dir> --input ... --font file.ttf` give every font id the one file. The worked example is `examples/plugins/nameplate-plain` (one file, no build).
- **Licences:** you do not have to show anything for outlines. A font file that you ship inside your package must come with its licence file.
- **Output files** (an SVG next to the mesh) cannot be returned yet; put the path data in `report` if the host wants it.

## 7. Performance and the triangle budget

- A host sets a general budget (`limits.maxTriangles`, 1 to 2 million in practice) and the engine refuses a result over it (`budget.triangles`). Your own `limits` in the manifest tighten it for your operation.
- A texture or pattern can multiply triangles. Estimate before you build, and stop early with a clear error (`myplugin.too_heavy` with the count) rather than run out of memory.
- Work on typed arrays, not objects per triangle. Check `ctx.signal.aborted` every few thousand steps.
- Measure on a 100 000 to 200 000 triangle mesh and put the numbers in your documentation. A phone is several times slower than a desktop.
- Return `quality: 'preview'` approximations only when they are clearly faster and flag them.

## 8. Workers and the sandbox

A plugin that was not built into the host (a `.amplugin` package) runs in a **sandbox**: a worker inside an iframe with a strict content policy. It has **no network** (`fetch`, `XMLHttpRequest` and `WebSocket` fail), no DOM and no storage, reads files only through `ctx.assets`, has a time limit per step, and every mesh it returns is checked (finite numbers, indices in range, within the budget, `plugin.bad_mesh` otherwise). A plugin that loops forever is ended and its step shows `run.timeout`. WebAssembly is allowed. A permission such as `network:https://api.example.org` in `manifest.permissions` widens the network rule for that plugin only, and only after the user approved the package.

Your module is bundled into **one file** by the packaging tool, so import only what is bundled: your own files and, if you need it, `MeshError` and helpers from `@ateliermesh/core` (a small part ends up in your file: the example package is 6 KB). Do not import from the host.

## 9. Texts

The manifest holds English titles (a fallback). The host draws everything else from its own language files, using fixed keys:

| What | Key |
|---|---|
| Operation title | `ops.<op>.title` and `step.op.<op>` |
| Section | `ops.<op>.sections.<id>` |
| Parameter | `ops.<op>.params.<name>.label`, `.help`, `.unit` |
| Enum option | `ops.<op>.params.<name>.options.<value>` |
| A problem (error or warning) | `mesh.<code>` (nested: `mesh.mirror.empty` for `mirror.empty`), with `{{placeholders}}` for the numbers in `params` |
| A progress stage | `ops.<op>.stage.<stage>` for your own stage names (shown while the step runs: "Building the blocks…"); the host's own `work.<stage>` for the names it knows (`weld`, `holes`, ...); anything else shows a generic "Working…" |

An unknown code falls back to `mesh.<prefix>._any`, then to a generic text, so a missing translation never shows a bare code only. The example has `locales/en.json`, `nl.json` and `fr.json` with exactly these keys. **UK English** for English texts. Write for the customer, not for a developer: say what happened, what to do, and put the numbers in. Dutch is the home language of the project; French is the third.

Where the texts go: **inside the repository**, merge them into `apps/standalone/src/locales/{en,nl,fr}.json` (the standalone and the demo read these; the Atelier merges the same keys into its i18next files). **For a `.amplugin` package** the `locales/` folder travels in the package (`amplugin pack` and `amplugin_pack.py` include it) and the host reads it: the standalone app and any host that follows `SPEC.md` section 3.1 merge your texts into its own, so labels, hints, option names and problem messages show in the user's language, falling back to English, then to the manifest's own English texts, then to the key. Rules:

- **Texts that are rejected, and where they go.** `amplugin check` fails a key outside your namespace and, when it can, says where it belongs. The usual mistakes: a **progress text** written as `work.build_blocks`, `stage.x` or `progress.x` goes to `ops.<operation id>.stage.<stage>`; an **error text** written as `blocks.too_big`, `errors.too_big` or `mesh.somethingelse.too_big` goes to `mesh.<prefix>.<code>` (the code the plugin throws, `blocks.too_big`, gives `mesh.blocks.too_big`).
- **Your own namespace only.** Allowed keys: `ops.<your operation id>.…`, `step.op.<your operation id>` and `mesh.<prefix>.…` where the prefix is one of your operation ids or the last part of your plugin id (`com.example.lithophane` gives `lithophane`; use it as the prefix of your problem codes). Everything else (`panel.*`, `fix.*`, the texts of the app or of other plugins) is left out. `amplugin check` and `pack` tell you which keys would be left out (pack refuses them).
- **Limits.** File names `<lang>.json` (`en`, `nl`, `fr`, `nl-BE`, ...), at most 8 files of 64 KB, nested at most 6 levels, 2000 texts of at most 1000 characters, only strings and objects. A package that breaks a limit is refused.
- **Plain text only.** `{{placeholders}}` are filled from the problem's `params`; no markup is ever rendered.
- A host that has the same operation id from another plugin (or a built-in) keeps the first one's texts, so give your operations ids of your own.

**Severity.** The channel decides: a `{ code, params }` you return in `warnings` is shown as a warning and does not block the result or saving; a problem you throw is an error and keeps the last good result. No list and no manifest field is needed for your own codes. (The host's own information codes, such as `run.cancelled`, stay information.) Use `warnings` for a result that is usable but needs a look, and throw for one that is not.

## 10. Versions and migration

A stored step records the plugin version that wrote it. When you change behaviour, raise `version` (major for breaking changes) and add `migrate(fromVersion, params, op)`, which returns the parameters in today's form. Renamed or split an operation? Add `migrateOp(fromVersion, op, params)` which returns the new operation id. Old projects then open and run. Never remove the ability to read an old step silently; if you cannot, throw a `MeshError` with a code. Add a test with a stored step of every old version you promise to support.

## 11. When a customer may change a setting

In the Atelier a designer builds the steps and hands some settings to the customer (a text, a size, a position). Your part is to say **which**:

- Per parameter: `"personalisable": true`. Per operation: `"personalisable": "never" | "optional" | "always"` (`never` forbids handing over anything). Hand over only what is safe to change freely, inside its `min` and `max`. The designer can narrow further: lines and characters for text, a distance, direction and size range for a placement.
- Anything not handed over cannot be changed by the customer. A host (or a server) checks it with the same code:

```ts
registry.validateStep(step, { role: 'customer', base: designerStep })   // { ok, errors }
```

  A change to a parameter that was not handed over gives `param.not_editable`; a value outside the manifest limits gives `param.out_of_range` (checked, `test/personalise.test.ts` in the example). A customer cannot add, remove, reorder or rename steps.
- Design for a customer who drags a slider: the operation must be quick (a live preview runs after every change) and must give a usable result everywhere inside its limits, or an error that says how to get back inside them.
- The customer never sees a material or a price from you, and you never see theirs.

## 12. Tests and fixtures

Test in three layers, all shown in `examples/plugins/mirror-full/test`:

1. **Pure function tests** for your algorithm on small meshes with known numbers. `@ateliermesh/core/testing` has `boxMesh`, `cylinderMesh`, `sphereMesh` and `lBracketMesh`, all closed solids with known volumes.
2. **Through the engine**: register your plugin in a `Registry` (`{ manifest, load: () => module }`) and call `runWorkflow`. This catches what a unit test misses: parameter validation, defaults, structured errors, cancellation, the closed-solid promise.
3. **Conformance fixtures** (`Fixture`): an input, steps, and expected measurements **with tolerances** (never bytes): `triangles`, `volume`, `size`, `bbox`, `watertight`, `step_reports`, or `ok: false` with an `error_code`. Run them with `runFixtures(fixtures, { registry })`. A host can run them with `runFixtures` against the plugin it loaded.

Always test: the manifest validates; a value over its limit is refused; the result is a closed solid with the right volume (a positive volume proves the winding is outward); groups and segments survive; an empty or broken input gives your error code, not a crash; an aborted signal stops the run (`run.cancelled`); the same input gives the same mesh twice; a customer cannot change what was not handed over. Check that your tests can fail: break the code on purpose once (the example's winding swap) and watch them go red.

Inside the repository the same pieces are in `packages/plugins/src/fixtures.ts` and `packages/plugins/test/*.test.ts`; `npm run check:packages` installs the packed tarballs in a clean project and runs every built-in fixture.

## 13. Packaging and signing

A package is a ZIP named `<id>-<version>.amplugin`: `manifest.json`, `main.js` (one bundled ES module with the default export), optional `assets/`, and for a signed package `manifest.sha256` (a hash of every file) and `manifest.sig` (an Ed25519 signature of that list).

The tool is `tools/amplugin.mjs` in the kit (`packages/loader/bin/amplugin.mjs` in the repository). It needs only Node 20 or newer. **It is not the npm package called `amplugin`**, which is an unrelated project: never install that one. Run the commands below from the plugin's folder, writing the path to the tool as it is from there (in the kit's example that is `../../../tools/amplugin.mjs`; the example's `npm run pack` and `npm run inspect` already do this).

```
node tools/amplugin.mjs pack . --out dist/com.example.mirror-1.0.0.amplugin     # compiles main.ts, bundles, zips
node tools/amplugin.mjs keygen dist/me                                           # me.key (secret, keep it out of git) and me.pub
node tools/amplugin.mjs sign . --key dist/me.key --out dist/signed.amplugin      # the same as: pack . --out dist/signed.amplugin --key dist/me.key
node tools/amplugin.mjs inspect dist/signed.amplugin --trust dist/me.pub        # prints id, hash, signer, files
node tools/amplugin.mjs verify dist/signed.amplugin --trust dist/me.pub         # like inspect, and fails unless that key signed it
```

A plugin written in plain JavaScript (`main.js`) packs with nothing installed. A plugin written in TypeScript (`main.ts`) needs `esbuild` in its own folder (`npm install -D esbuild`; the example has it); without it the tool says so.

Rules the loader enforces (checked): an invalid manifest, a hash mismatch, an unlisted or missing file or an id that clashes with a built-in plugin refuses the package. **A signature that none of the user's trusted keys verifies also refuses it**, so a package signed with a key the user has not imported will not load; an unsigned package loads, labelled **Unsigned**, after the user approves. Whoever loads your signed plugin adds your **public** key under *Trusted signers*. A signature proves who wrote a plugin, not that it is safe: the sandbox does that. Never put the `.key` file in the package or in git.

### Publishing your plugin to a catalog
A server that runs the plugin catalog (the standalone site's optional `catalog/` folder, see its README) keeps packages for people to find in the plugin manager under **Add a plugin, Search in the catalog**. Its owner gives you the address of the upload page and a password; you upload the `.amplugin` file there. The page checks it again: a valid id and version, your licence and description, the example picture, the checksums. Things to know:
- Upload each release as its own version (1.0.0, 1.1.0, ...). The newest version is what people get; installed copies show **Update available** and update after their own approval. A version number cannot be reused unless the owner ticks Replace.
- The catalog lists your name, description, licence, contact and example picture from your manifest, so fill them in well (they are public).
- Sign the package (`amplugin sign`) if you want people to know it is yours: they trust your public key once, and later versions come with a signature they can check. The catalog only notes that a signature file is present.
- The catalog does not change your `package_url`. Put one in the manifest only if you also serve the file from your own address.

## 14. A worked example: Mirror

`examples/plugins/mirror-full`: mirror a model in place (`flip`) or add a mirrored copy beside it (`copy`, with a `gap`). It keeps segments and groups, names the new bodies, reports an empty mesh with a code and stops when cancelled. Built and tested from the packed tarballs (11 tests). To check that the tests can fail, the triangle winding swap was removed on purpose: two tests went red (the fixtures and the in-place mirror), and green again when it was put back.

**`manifest.json`**

```json
{
  "manifest_version": 1,
  "id": "com.example.mirror",
  "name": "Mirror",
  "version": "1.0.0",
  "author": "Example Ltd",
  "license": "MIT",
  "operations": [
    {
      "id": "mirror",
      "title": "Mirror",
      "kind": "modifier",
      "category": "shape",
      "personalisable": "never",
      "stages": ["mirror"],
      "outputs": { "mesh": true, "report": true, "closed": true },
      "sections": [{ "id": "plane", "title": "Plane" }],
      "params": [
        { "name": "axis", "type": "enum", "default": "x", "options": ["x", "y", "z"], "section": "plane" },
        { "name": "mode", "type": "enum", "default": "flip", "options": ["flip", "copy"], "section": "plane" },
        { "name": "gap", "type": "float", "default": 2, "min": 0, "max": 200, "step": 0.5, "unit": "mm", "visible_if": "mode == 'copy'", "section": "plane" }
      ]
    }
  ]
}
```

**`src/mirror.ts`**: the algorithm as a plain function, easy to test.

```ts
// The mirror operation as a plain function: easy to test without an engine, and the module in main.ts only wraps it.
import { MeshError } from '@ateliermesh/core'
import type { Mesh, MeshGroup } from '@ateliermesh/core'

export interface MirrorParams { axis: 'x' | 'y' | 'z'; mode: 'flip' | 'copy'; gap: number }
const AXIS = { x: 0, y: 1, z: 2 } as const

export function mirror(mesh: Mesh, p: MirrorParams, isCancelled: () => boolean = () => false): { mesh: Mesh; report: Record<string, unknown> } {
  const nv = mesh.positions.length / 3, nt = mesh.indices.length / 3
  if (nt === 0) throw new MeshError('mirror.empty')               // an expected problem: a MeshError with a code, never a bare Error
  const a = AXIS[p.axis]
  let lo = Infinity, hi = -Infinity
  for (let i = a; i < mesh.positions.length; i += 3) { const v = mesh.positions[i] as number; if (v < lo) lo = v; if (v > hi) hi = v }
  if (isCancelled()) throw new MeshError('run.cancelled')

  // flip: mirror in place (the bounding box stays where it is). copy: add a mirrored copy `gap` mm beyond the far end.
  const plane = p.mode === 'flip' ? lo + hi : 2 * hi + p.gap
  const copies = p.mode === 'flip' ? 1 : 2
  const positions = new Float64Array(mesh.positions.length * copies)
  const indices = new Uint32Array(mesh.indices.length * copies)
  const base = p.mode === 'flip' ? 0 : 1                           // the mirrored triangles start at this copy
  if (p.mode === 'copy') { positions.set(mesh.positions); indices.set(mesh.indices) }
  const po = base * mesh.positions.length, io = base * mesh.indices.length
  for (let i = 0; i < mesh.positions.length; i++) positions[po + i] = i % 3 === a ? plane - (mesh.positions[i] as number) : (mesh.positions[i] as number)
  // a mirror image turns every triangle inside out: swap two corners so it faces outwards again (counter-clockwise from outside)
  for (let t = 0; t < nt; t++) {
    indices[io + 3 * t] = (mesh.indices[3 * t] as number) + base * nv
    indices[io + 3 * t + 1] = (mesh.indices[3 * t + 2] as number) + base * nv
    indices[io + 3 * t + 2] = (mesh.indices[3 * t + 1] as number) + base * nv
  }
  const out: Mesh = { positions, indices }

  // carry the labels through: segments follow their triangles, groups (bodies) follow their ranges
  if (mesh.segments) {
    const labels = new Uint16Array(nt * copies)
    if (p.mode === 'copy') labels.set(mesh.segments.labels)
    labels.set(mesh.segments.labels, base * nt)
    out.segments = { labels, table: mesh.segments.table.map(s => ({ ...s })) }
  }
  if (p.mode === 'copy') {
    const own: MeshGroup[] = mesh.groups ?? [{ start: 0, count: nt, role: 'solid', name: 'original' }]
    out.groups = [...own.map(g => ({ ...g })), ...own.map((g, i) => ({ start: g.start + nt, count: g.count, role: g.role, name: `${g.name ?? `part_${i + 1}`}_mirror` }))]
  } else if (mesh.groups) out.groups = mesh.groups.map(g => ({ ...g }))
  return { mesh: out, report: { axis: p.axis, plane: p.mode === 'flip' ? (lo + hi) / 2 : hi + p.gap / 2, triangles: nt * copies } }
}
```

**`main.ts`**: the module, a thin wrapper.

```ts
// The plugin module: one default export with a `run` function for all the plugin's operations.
import { MeshError } from '@ateliermesh/core'
import type { PluginModule } from '@ateliermesh/core'
import { mirror } from './src/mirror'
import type { MirrorParams } from './src/mirror'

export default {
  async run(op, ctx) {
    if (op !== 'mirror') throw new MeshError('step.unknown_op', { op })
    if (!ctx.mesh) throw new MeshError('input.missing_mesh', { op })
    ctx.progress('mirror', 0)
    const r = mirror(ctx.mesh, ctx.params as unknown as MirrorParams, () => ctx.signal.aborted)
    ctx.progress('mirror', 1)
    return r
  },
} satisfies PluginModule
```

**`test/mirror.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { Registry, addStep, emptyStepList, makeStep, measureMesh, runFixtures, runWorkflow, validateManifest, validateParams } from '@ateliermesh/core'
import type { Fixture, Mesh } from '@ateliermesh/core'
import { boxMesh } from '@ateliermesh/core/testing'
import manifest from '../manifest.json'
import module from '../main'

const ID = 'com.example.mirror'
const registry = new Registry().register({ manifest: manifest as never, load: () => module })
const step = (params: Record<string, unknown>) => makeStep({ id: 's1', plugin: { id: ID, version: '1.0.0' }, op: 'mirror', params })
const run = (params: Record<string, unknown>, source: Mesh, signal?: AbortSignal) =>
  runWorkflow(addStep(emptyStepList(), step(params)), { registry, source, ...(signal ? { signal } : {}) })

describe('the manifest', () => {
  it('is valid, and its limits are enforced', () => {
    expect(validateManifest(manifest).ok).toBe(true)
    const op = manifest.operations[0] as never
    expect(validateParams(op, { axis: 'x', mode: 'copy', gap: 9999 }).ok).toBe(false)   // max 200
    expect(validateParams(op, { axis: 'q' }).ok).toBe(false)                              // not one of the options
  })
})

describe('conformance fixtures (the same format the built-in plugins use)', () => {
  const fixtures: Fixture[] = [
    { name: 'flip a 10 x 20 x 30 box in place', input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } }, steps: [step({ axis: 'x', mode: 'flip' })],
      expect: { triangles: 12, volume: { value: 6000, tol: 1e-6 }, size: { value: [10, 20, 30], tol: 1e-9 }, watertight: true } },
    { name: 'a copy beside it doubles the triangles and the width', input: { kind: 'generator', name: 'box', params: { width: 10, depth: 20, height: 30 } }, steps: [step({ axis: 'x', mode: 'copy', gap: 2 })],
      expect: { triangles: 24, volume: { value: 12000, tol: 1e-6 }, size: { value: [22, 20, 30], tol: 1e-9 }, watertight: true } },
    { name: 'a gap above the limit is refused', input: { kind: 'generator', name: 'box' }, steps: [step({ axis: 'x', mode: 'copy', gap: 500 })], expect: { ok: false, error_code: 'param.out_of_range' } },
  ]
  it('pass', async () => {
    for (const r of await runFixtures(fixtures, { registry })) expect(r.failures, r.name).toEqual([])
  })
})

describe('the operation', () => {
  const box = boxMesh(10, 20, 30)
  it('mirrors in place: the vertices move, the triangles still face outwards', async () => {
    const r = await run({ axis: 'z', mode: 'flip' }, box)
    expect(r.ok).toBe(true)
    const m = r.mesh!
    expect(measureMesh(m).volume).toBeCloseTo(6000, 6)                // a positive volume means the winding is outward
    expect(m.indices.length).toBe(box.indices.length)
  })
  it('keeps segments and groups through a copy, and names the new bodies', async () => {
    const nt = box.indices.length / 3
    const labelled: Mesh = { ...box, segments: { labels: Uint16Array.from({ length: nt }, (_, i) => (i < 2 ? 1 : 0)), table: [{ id: 0, name: 'body' }, { id: 1, name: 'lid' }] }, groups: [{ start: 0, count: nt, role: 'solid', name: 'box' }] }
    const m = (await run({ axis: 'y', mode: 'copy', gap: 1 }, labelled)).mesh!
    expect(m.segments!.labels.length).toBe(nt * 2)
    expect(Array.from(m.segments!.labels.slice(nt, nt + 3))).toEqual([1, 1, 0])
    expect(m.groups!.map(g => [g.name, g.start, g.count])).toEqual([['box', 0, nt], ['box_mirror', nt, nt]])
  })
  it('gives two bodies named original and mirror_... when the input had none', async () => {
    const m = (await run({ axis: 'x', mode: 'copy' }, box)).mesh!
    expect(m.groups!.map(g => g.name)).toEqual(['original', 'original_mirror'])
  })
  it('reports an empty mesh with a code, not a crash', async () => {
    const r = await run({ axis: 'x', mode: 'flip' }, { positions: new Float64Array(0), indices: new Uint32Array(0) })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('mirror.empty')
  })
  it('stops when cancelled', async () => {
    const ac = new AbortController(); ac.abort()
    const r = await run({ axis: 'x', mode: 'flip' }, box, ac.signal)
    expect(r.ok).toBe(false)
    expect(r.results[0]!.error?.code).toBe('run.cancelled')
  })
  it('gives the same mesh for the same input', async () => {
    const a = (await run({ axis: 'x', mode: 'copy', gap: 3 }, box)).mesh!, b = (await run({ axis: 'x', mode: 'copy', gap: 3 }, box)).mesh!
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions)); expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })
})
```

**`test/personalise.test.ts`**: what a customer may change.

```ts
import { describe, expect, it } from 'vitest'
import { Registry, makeStep } from '@ateliermesh/core'
import manifest from '../manifest.json'
import module from '../main'

// a copy of the manifest in which the designer may hand the gap to the customer
const handedOver = JSON.parse(JSON.stringify(manifest)) as { operations: Array<{ personalisable?: string; params: Array<{ name: string; personalisable?: boolean }> }> }
handedOver.operations[0]!.personalisable = 'optional'
handedOver.operations[0]!.params.find(p => p.name === 'gap')!.personalisable = true
const registry = new Registry().register({ manifest: handedOver as never, load: () => module })

const designer = makeStep({ id: 's1', plugin: { id: 'com.example.mirror', version: '1.0.0' }, op: 'mirror', params: { axis: 'x', mode: 'copy', gap: 2 }, personalisable: true, personalisable_params: ['gap'] })
const asCustomer = (params: Record<string, unknown>) => registry.validateStep({ ...designer, params: { ...designer.params, ...params } }, { role: 'customer', base: designer })

describe('what a customer may change', () => {
  it('accepts a change to the parameter the designer handed over, inside its limits', () => { expect(asCustomer({ gap: 10 }).ok).toBe(true) })
  it('refuses a change to anything else', () => {
    const r = asCustomer({ axis: 'z' })
    expect(r.ok).toBe(false)
    expect(r.errors[0]!.code).toBe('param.not_editable')
  })
  it('refuses a value outside the manifest limits', () => { expect(asCustomer({ gap: 999 }).ok).toBe(false) })
})
```

**`package.json`**, **`tsconfig.json`** and the texts (`locales/en.json`, `nl.json`, `fr.json`) are in the folder. The English texts:

```json
{
  "ops": {
    "mirror": {
      "title": "Mirror",
      "sections": {
        "plane": "Plane"
      },
      "params": {
        "axis": {
          "label": "Axis",
          "help": "The mirror plane is perpendicular to this axis.",
          "options": {
            "x": "X",
            "y": "Y",
            "z": "Z"
          }
        },
        "mode": {
          "label": "Mode",
          "help": "Flip mirrors the model where it stands. Copy adds a mirrored copy next to it.",
          "options": {
            "flip": "Flip",
            "copy": "Copy"
          }
        },
        "gap": {
          "label": "Gap",
          "help": "The space between the model and its copy."
        }
      }
    }
  },
  "step": {
    "op": {
      "mirror": "Mirror"
    }
  },
  "mesh": {
    "mirror": {
      "empty": "This model has no triangles to mirror."
    }
  }
}
```

What to notice: the error is a `MeshError` with a plugin-prefixed code; the winding is swapped because a mirror image turns every triangle inside out; `plane - v` mirrors a coordinate; in `copy` mode the second body gets group ranges that start after the first and a `_mirror` name; cancellation is checked before the heavy loops; nothing random, nothing global.

### The plain JavaScript version

The same plugin without TypeScript, tests or a build is `examples/plugins/mirror-plain` (kit and repository): one `main.js` (about 60 lines, no imports; `MeshError` becomes a plain `{ code, params }` object), `manifest.json`, `fixtures.json` and `locales/`. Its checks run with `node tools/amplugin.mjs check examples/plugins/mirror-plain`, a try-out with `node tools/amplugin.mjs run examples/plugins/mirror-plain --input generator:box:10,20,30 --params '{"mode":"copy","gap":2}' --out result.stl`, and the package with `node tools/amplugin.mjs pack examples/plugins/mirror-plain` (or `python3 tools/amplugin_pack.py ...`). Choose it when you have no npm; choose `mirror-full` when you want TypeScript and the engine's own test runner.

## 15. Troubleshooting

| Symptom | Cause |
|---|---|
| `manifest.invalid` with `bad_plugin_id` | The id is not reverse-domain lower case (`Mirror` should be `com.you.mirror`). |
| `manifest.invalid` with `bad_default` | A default that its own type or limits refuse (a value not in `options`, a number outside `min`/`max`). |
| `manifest.invalid` with `unknown_param_type` | A parameter type this version does not know: use one from section 3. |
| `param.out_of_range` or `param.not_enum` | The step has a value outside the manifest limits or options; the engine refused it before `run`. |
| `param.not_editable` | A customer-role check: that parameter was not handed over. |
| `plugin.crashed`, plugin switched off | Something that is not a `MeshError` escaped `run` (a `TypeError`, a bad import). Fix it, then switch the plugin on again. |
| `plugin.bad_mesh` with `problem: "not_closed"` | The manifest promises `outputs.closed` and the input was closed, but your result is not (a hole, a flipped triangle). |
| `plugin.bad_mesh` (other problems) | NaN in positions or an index out of range. The engine checks every result of a plugin loaded from a package. |
| `budget.triangles` | The result has more triangles than the host's limit or your `limits.max_output_triangles`. |
| `run.timeout` | The step ran longer than the host allows; check `signal.aborted` in loops and cut the work. |
| Volume of the result is negative | Triangles face inwards. A mirror, a flip or a bad boolean turned them; swap two corners of each flipped triangle. |
| A later step cannot find your segment | You dropped `segments` (or renamed them). Carry labels through (section 5) and declare `outputs.segments`. |
| `loader.invalid_package` with `signature_not_trusted` | The package is signed with a key the user has not trusted. Trust the public key, or ship it unsigned. |
| `ERR_MODULE_NOT_FOUND ... esbuild` when packing | The packaging tool must sit inside a folder whose `node_modules` has `esbuild` (copy it to `tools/`, not next to the folder). |
| The panel shows "LET TERS" above a choice called `mode` | The host's form uses emboss wording for a field named `mode` (a known gap; give it a `label` in your texts). |
| Fields show the English manifest titles in a Dutch host | The host has no texts for your keys (section 9). |

## 16. Pre-release checklist

- [ ] `id` is reverse-domain and yours; `version` raised; `license` and `description` are written in the manifest (and `contact` / `package_url` if you have them); the licence is permissive.
- [ ] `validateManifest` passes; every default is valid; limits are real hard limits.
- [ ] `category` set; `personalisable` set on the operation and only on parameters that are safe to hand over.
- [ ] Presentation hints considered (`widget`, `importance`, `icon`, `summary`). <!-- TODO(plugin-guide): link the hints section when it exists. -->
- [ ] Result is a closed solid when the input was; `outputs.closed` set if you promise it.
- [ ] Segments carried through; groups valid; new names declared in `outputs`.
- [ ] Deterministic: no `Math.random`, `Date`, network or global state; same input, same output.
- [ ] Errors are `MeshError` with a prefixed code and the numbers in `params`; nothing else can escape `run`.
- [ ] Cancellation checked in loops; progress stages reported.
- [ ] Measured on 100k to 200k triangles; the numbers are in your documentation; a clear error when too heavy.
- [ ] Tests: pure function, through the engine, fixtures, cancellation, customer rules, old-version migration. You broke the code once to see them fail.
- [ ] Texts in en (UK English), nl and fr for the operation, sections, parameters, options, every error and warning code (`mesh.<prefix>.<code>`) and every stage you report (`ops.<op>.stage.<stage>`). Run `amplugin check`: it fails any text outside your namespace and says where it belongs.
- [ ] An example 3MF or STL before and after, and a short page that says what the plugin does and does not do.
- [ ] Packed, `inspect`ed, loaded in the standalone app from a file, added from the menu, run on a real model.
- [ ] Signed if you distribute it, with the public key published separately.

## 17. If you work inside the repository (repository only)

> **Only for the AtelierMesh repository.** If you work from the plugin kit, skip this section: the files it names are not in the kit. What every finished plugin contains, wherever you work, is in Appendix A.

A built-in plugin lives in `packages/plugins/src/<name>-plugin.ts` (manifest and `PluginEntry`, code loaded on first use) and `<name>-run.ts` (the module), exported from `index.ts`, with fixtures in `fixtures.ts`. To add one: write those files; export `xPlugin`, `xManifest`, `X_PLUGIN_ID`, `X_PLUGIN_VERSION` and `xFixtures`; add it to `BUILT_IN_PLUGINS` in `packages/plugins/src/builtin.ts`; register it in `apps/standalone/src/App.tsx` and `apps/standalone/src/worker.ts`, `apps/demo/src/main.ts` and `apps/demo/src/worker.ts`, and in the React test harnesses (`packages/react/test/fixtures/*.tsx`) when they do not use the helper; add a probe line to `scripts/check-packages.mjs`; put the texts into `apps/standalone/src/locales/{en,nl,fr}.json` and list the new ones in `docs/design-texts-<name>.md` for design to confirm; write the tests in `packages/plugins/test`; document it in `SPEC.md` section 5A and `CHANGELOG.md`. Run `npm run check`, `npm run check:packages` and, for anything with a UI effect, the standalone journeys.

## 18. Gaps in the tooling (found while writing this guide)

These are real today; each has a workaround above.

1. **No published tooling package.** Nothing of ours is on npm. The packing tool ships in the plugin kit (`tools/amplugin.mjs`; `packages/loader/bin/amplugin.mjs` in the repository) and needs only Node 20 or newer; a published `@ateliermesh/plugin-tools` with `create`, `validate`, `pack` and `test` commands would remove the copying. The npm package called `amplugin` is a different, unrelated project.
2. **No scaffold and no validate command.** Start by copying `examples/plugins/mirror-full` (the kit has it); validate with `validateManifest` in a test.
3. **Done: package `locales/` are read** (section 9). A plugin can add a text for its own stage names (`ops.<op>.stage.<stage>`); it cannot yet add a `field.<name>` key; those stay the host's.
4. **Done: warning severity follows the channel** (section 9). A plugin cannot mark a code as information.
5. **A signed package with an untrusted key is refused with raw text** (`loader.invalid_package {"reason":"signature_not_trusted"}`), not a sentence, and there is no "trust this key" step in the load dialog.
6. **The step form has emboss wording** for a field called `mode` ("Letters") until the presentation hints replace it.
7. **The `plugins.lock.json` entries carry id and version only**; a project does not yet remember the package hash.
8. **Stage names: your own text wins.** `WorkingRow` shows `ops.<op>.stage.<stage>` from the package when it exists, then the host's own `work.<stage>` (`stageKey` in `packages/ui/src/problems.ts`, a fixed list), then "Working…".

## Appendix A. What a finished plugin contains, wherever you work

| Item | A plugin from the kit (an external package) | A built-in plugin (repository) |
|---|---|---|
| Manifest: id, version, operations, settings with limits, units, conditions, parts it makes, stages | `manifest.json` | `<name>-plugin.ts` |
| The module: one default export with `run(op, ctx)` | `main.ts` (or `main.js`) and `src/` | `<name>-run.ts` and `<name>.ts` |
| Tests and conformance fixtures (the real engine, `runFixtures`) | `test/*.test.ts` (vitest; `npm test`) | `packages/plugins/test` and `fixtures.ts` |
| Texts in en (UK English), nl, fr: operation, sections, settings, options, every error and warning code, every stage | `locales/en.json`, `nl.json`, `fr.json` | `apps/standalone/src/locales/*.json` and `docs/design-texts-<name>.md` |
| A short page saying what the plugin does and does not do, with an example file before and after | `README.md` and a sample `.3mf` or `.stl` | `SPEC.md` section 5A, `docs/samples/` |
| Packaging | `npm run pack` (the kit's `tools/amplugin.mjs`), signed with `keygen` and `sign` if you distribute it | exported from the package, `npm run pack` |
| Proof it loads | **Plugins… / Choose a plugin file** in the standalone app, then add it from the menu on a real model | `npm run check:packages`, the standalone journeys |
