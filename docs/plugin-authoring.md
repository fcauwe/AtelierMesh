# Writing a plugin

> New to this? Start with [`plugin-guide.md`](plugin-guide.md) (the whole path, a worked example and a checklist). To have a coding agent build a plugin for you, give it [`prompt-make-a-plugin.md`](prompt-make-a-plugin.md). This page has the exact interfaces.

A plugin is a **manifest** (JSON, describes the operations and their parameters) plus a **module** (code, one `run` function for all its operations). The host builds the parameter panel from the manifest and calls `run`. Types below are from `@ateliermesh/core`.

## 1. The manifest

```json
{
  "manifest_version": 1,
  "id": "com.example.scale",
  "name": "Scale",
  "version": "1.0.0",
  "license": "MIT",
  "description": "Scales a model uniformly or in the x and y directions only.",
  "contact": { "name": "Example Ltd", "url": "https://example.org/plugins" },
  "operations": [
    {
      "id": "scale", "title": "Scale", "kind": "modifier", "personalisable": "optional",
      "params": [
        { "name": "factor", "type": "float", "default": 100, "min": 10, "max": 1000, "unit": "%", "personalisable": true },
        { "name": "mode", "type": "enum", "default": "uniform", "options": ["uniform", "xy"] }
      ]
    }
  ]
}
```

Rules (checked by `validateManifest`; a plugin with an invalid manifest is refused):
- `id`: reverse-domain, lower case (`com.example.scale`). `version`: `major.minor.patch`.
- `license` and `description` are **required** for an external package and every built-in plugin (an SPDX id such as `MIT`, `Apache-2.0`, `GPL-3.0-only`, or `Proprietary`; plain text of 10 to 300 characters). `contact` (`{ url (https), email, name }`) and `package_url` (the https address of the packed file, for "Check for update") are optional. A missing or malformed one is reported as `manifest.missing_license`, `manifest.missing_description`, `manifest.bad_license`, `manifest.bad_description`, `manifest.bad_contact` or `manifest.bad_package_url`. Never invent contact details.
- Operation ids and parameter names: `^[a-z][a-z0-9_]*$`, unique inside their scope.
- `kind`: `generator` (needs no input mesh), `modifier` (mesh in, mesh out), `analyzer` (mesh in, report out), `exporter`.
- `category` (optional): where the operation sits in the host's "Add a step" menu. Well known: `prepare` (repair, clean up), `shape` (basic shape changes: resize, rotate, hollow, cut a hole, deform), `style` (an artistic restyling of the whole model: low poly, a lattice shell, swiss-cheese holes), `surface` (put something on the surface), `check` (analyse without changing). Any other lowercase id becomes its own group, titled by the host's text `addStep.cat.<id>` (or the id itself). Left out: `check` for an analyzer, `shape` for everything else. The groups appear in the order prepare, shape, style, surface, check, then the others.
- `importance` (optional, on an operation): `normal` (default) or `low`. When the menu is long (more than 12 operations) the `low` ones are folded into a "More" group: use it for checks and rarely used steps.
- `icon` (optional, on the **manifest**, next to `id` and `name`): the name of an icon for the plugin as a whole. A plugin that has one and three or more operations under one heading is shown as one menu row with a submenu ("Deform ›"); without it its operations are listed one by one.
- Every parameter has a `type` and a valid `default`. `min` and `max` are **hard limits**, enforced on the server too, not UI hints.
- Parameter types: `bool`, `int`, `float`, `string` (`min_length`, `max_length`, `pattern`), `enum` (`options`), `vector` (`size` 2 or 3), `angle`, `asset`, `payload` (a stored mesh or drawing by name, see "Drawings and stored items"), `placement`.
- `personalisable: true` marks a parameter a designer *may* hand to the customer. Nothing else is ever personalisable.
- Unknown extra fields are ignored (use a namespaced `x-yourhost` block). An unknown parameter **type** refuses the plugin.
- `personalisable: "never"` forbids handing any parameter of the operation to the customer.

### How it looks (presentation hints)

The manifest says what each field is; a few optional hints say how it should be presented. A host draws the same designed form for every plugin from them, so a plugin needs no UI code. Every hint is optional, a host that does not know one shows the plain control, and a hint never changes what a value means (`manifest_version` stays 1). `validateManifest` checks them, so a typo is noticed.

| Hint | On | Values | What the form does |
|---|---|---|---|
| `widget` | an `enum` | `segmented`, `cards` | Buttons in one row (the default for up to four choices), or cards. More than four choices are a list, **unless** some option has an `icon` the host knows: then they are cards with the icon shown (a list cannot show it). A `widget` hint always wins. |
| `shape_style` | an `enum` | `line` (default), `fill` | How the pictures made from an option's `shape` are drawn: as an outline, or as a solid silhouette (for marks that are solid shapes). The chosen card always shows a tick, whatever the style. |
| `widget` | an `int`, `float` or `angle` | `slider`, `stepper` | A range slider with its number box (needs `min` and `max`), or a number box with minus and plus buttons. Without a hint: the number box and its unit. |
| `widget` | a `vector` | `axes` | One box per axis, with the axis written in front (`labels`) and the unit after. This is the default for a vector. |
| `widget` | an `asset` | `font`, `gallery` | A grid of fonts (`preview: 'text'` shows the user's own wording) or of pictures. |
| `importance` | any field | `main`, `normal`, `advanced` | `main` fields come first, in an open group of their own; `advanced` ones go into the collapsed "More" group. Fields without it stay in their `sections`. |
| `help` | any field | a sentence | A line under the field (translated through `ops.<op>.params.<name>.help` when the host has it). |
| `shape` | an enum option | the `d` of an SVG path on a **24 × 24** grid, for example `"M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z"` | A picture of the choice's own, drawn as a one-colour outline (stroke, no fill, round line ends and joins, the colour of the text), or as a solid silhouette when the parameter says `shape_style: "fill"` (see below). Cards draw it at 48 px, buttons (four choices or fewer) at 24 px. It wins over `icon`; more than four choices with a shape are cards. Path data only (the characters of a path, at most 1000, at most 64 options with a shape); anything else is a manifest error `bad_shape`. A host that does not know it shows the plain control. Colour is not part of it: colours are the segments' business. |
| `icon` | a field, an operation or an enum option | a lowercase name (`twist`, `arrow-up`) | A small icon next to the label, in the step list, or on the button. A host that does not have the name shows none. |
| `summary` | an operation | `'{{angle}}°'` | The line under the step's name in the step list. `{{name}}` is a parameter of the operation; numbers are rounded to two decimals. |

**Outline or solid (0.4.2).** Set `shape_style` on the `enum` parameter: `"line"` (default, an outline: open or thin drawings) or `"fill"` (a solid silhouette: closed paths ending in `z`). One style for all its options. Any other value is the manifest error `bad_shape_style`; an older host draws outlines.

```json
{ "name": "motif", "type": "enum", "default": "none", "shape_style": "fill",
  "options": [ { "value": "none", "label": "None" }, { "value": "heart", "label": "Heart", "shape": "M12 21s-8-5.4-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.6-8 11-8 11z" } ] }
```

The host marks the chosen card itself (border, tint, tick): do not draw a selection in the shape.

Rules of the form: the first group is open and the others are collapsed unless a section says `collapsed: false`; fields that name no section form a group "Settings" at the top; a field with `personalisable: true` gets the "Personalisable" tick on its label row when the designer's switch is on; an enum option may be `{ value, label, icon }` and its `label` is the fallback when the host has no translation. Titles and labels are English (UK); a host translates them through its locale files.

```json
{
  "id": "twist", "title": "Twist", "kind": "modifier", "category": "shape", "icon": "twist", "summary": "{{angle}}°",
  "params": [
    { "name": "angle", "type": "float", "default": 90, "min": -1440, "max": 1440, "unit": "deg", "widget": "slider", "importance": "main", "personalisable": true },
    { "name": "easing", "type": "enum", "default": "linear", "options": [{ "value": "linear", "label": "Linear" }, { "value": "smooth", "label": "Smooth" }], "widget": "segmented" },
    { "name": "detail", "type": "int", "default": 3, "min": 1, "max": 9, "widget": "stepper", "importance": "advanced", "help": "How finely the shape is cut." }
  ]
}
```

In the JSON Schema export (`operationParamsSchema`) the hints appear as the annotations `x-widget`, `x-importance` and `x-icon`; a validator ignores them.

## 2. The module

```ts
import type { PluginModule } from '@ateliermesh/core'

export default {
  async run(op, ctx) { /* return { mesh?, report?, warnings? } */ },
  migrate(fromVersion, params, op) { /* return params for the current version */ },   // optional
} satisfies PluginModule
```

`ctx` (type `RunContext`):

| Field | Meaning |
|---|---|
| `params` | Validated, defaults filled, within limits. Never re-validate. |
| `mesh` | Input mesh from the previous step; absent for the first step of a generator. |
| `payload` | What the previous step produced, whatever its kind (a mesh, or a `Drawing`). The same object as `mesh` when it is a mesh. |
| `payloads` | The stored items the step asked for with `payload` parameters, by parameter name (`ctx.payloads.shape`). An empty object when the step has none. Read only. |
| `assets(id)` | `Promise<Uint8Array>`: bytes of a font, texture or file, resolved by the host. The only way to read outside data. |
| `fonts.outline(fontId, text, options)` | `Promise<FontOutlines>`: letter outlines made by the host (see "Fonts and text"). Needs `"uses": ["fonts"]` in the manifest. |
| `quality` | `'preview'` or `'export'`. A fast approximation is allowed for `preview`; if you do, set `report.preview_approximate = true`. |
| `progress(stage, fraction)` | Report progress, `fraction` 0 to 1. |
| `signal` | `AbortSignal`. Check it regularly and stop. A plugin that ignores it is terminated after a grace period. |
| `log(level, message)` | `info`, `warn`, `error`. |

Result (`RunResult`): `mesh` (required for `generator` and `modifier`), `report` (plain JSON numbers, strings, booleans), `warnings` (`StructuredError[]`: shown as non-blocking warnings; a thrown problem is an error). Texts for your codes go in `locales/<lang>.json` under `mesh.<code>` (SPEC.md section 3.1).

Requirements:
- **Pure**: the result depends only on `op`, `params`, `mesh`, `assets` and `quality`. No hidden state between runs, no clock, no randomness (or a seed in the params). The cache relies on it.
- **Do not mutate** the input mesh; return new arrays.
- **Errors**: throw `new MeshError('my.code', { detail })`, a code plus parameters, never only a sentence, so the host can translate it.
- No network, DOM, storage or filesystem unless the manifest declares the permission and the host grants it (see `external-plugins.md`).

## 3. The mesh

```ts
interface Mesh {
  positions: Float64Array   // x,y,z per vertex, millimetres, right-handed, Z up
  indices: Uint32Array      // three per triangle, counter-clockwise seen from outside
  groups?: { start: number; count: number; role: 'solid' | 'negative'; name?: string; color?: string }[]
  segments?: { labels: Uint16Array; table: { id: number; name: string; color?: string }[] }
}
```

Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export. Keep the colours of the parts you keep (copy the table entries and the groups with every field); a colour that is not `#rrggbb` makes the result invalid (`plugin.bad_mesh`). Details and code: `plugin-guide.md`, section 5, and [3mf-colour.md](3mf-colour.md) for the export.

## 4. Placement

Operations that act on a spot of the surface take a `placement` parameter: an anchor (`point`, `normal`, optional triangle hint `tri`, barycentric `bary`, `fingerprint`) plus `up_ref` (`x`, `y`, `z`), `direction` (degrees, -180 to 180), `offset` ([u, v] mm) and `align`. The host writes it when the customer clicks the surface. See `SPEC.md` §5A.7.

## 5. Testing a plugin

`@ateliermesh/core/testing` has small meshes with known volumes (`boxMesh`, `cylinderMesh`, `sphereMesh`, `lBracketMesh`) and a test plugin. Write **conformance fixtures** (`Fixture`: input, steps, expected measurements with tolerances, never bytes) and run them with `runFixtures`. Also check:
- your manifest passes `validateManifest`;
- `operationParamsSchema` gives a JSON Schema and it agrees with `validateParams` on your own cases;
- a run with `signal` aborted stops quickly.

## 6. Errors the engine itself reports

**When your plugin crashes.** Throw `MeshError` for anything you expect (`my_plugin.too_thin`, with the numbers a person needs). Anything else that escapes `run` (a `TypeError`, a `ReferenceError`, a failed import, a worker that dies) is a crash: the engine returns `plugin.crashed` with the plugin, the step, the phase (`load`, `run` or `worker`) and the first line of the message, switches your plugin off (`registry.setEnabled`) and the editor shows a banner with "Switch on again" and "Manage plugins…". A cancellation or a timeout is not a crash. Fix the bug, then switch the plugin on again; a plugin that failed to load gets a fresh try.

`manifest.invalid`, `param.unknown`, `param.type`, `param.out_of_range`, `param.not_enum`, `param.too_long`, `param.too_short`, `param.pattern`, `param.length`, `param.not_editable`, `param.invalid`, `step.invalid`, `step.unknown_plugin`, `step.unknown_op`, `step.version_newer`, `step.not_personalisable`, `input.missing_mesh`, `run.cancelled`, `run.timeout`, `budget.triangles`, `budget.vertices`, `plugin.failed`. Plugins add their own codes, prefixed with their area (`emboss.stretch_too_high`).

## For heavier operations (images, masks, layers, big meshes)
- **An image or texture:** an `asset` parameter with `accept: ["image/png", "image/jpeg"]`, `library`, `widget: "gallery"`, and `allow_upload`, `categories`, `searchable` when the host should offer them. In `run`, `await ctx.assets(id)` gives the bytes; `decodeImage` (from `@ateliermesh/core`) turns them into RGBA pixels; reading them as heights or a mask is up to the plugin.
- **A colour:** a `color` parameter (with `palette` and `only_palette` for a fixed set). **Fields that belong together** (an outline with width and colour): an `object`. **Work on one distinct part of the mesh** (a lid, a base): a `part` parameter (`kinds: ["group"]`), then `selectPart`. The same `part` type picks a labelled segment; with no `kinds` it offers both.
- **Angles or distances as a band:** a `range` parameter. **Several of something** (texture layers, each with its own image, strength and mask): a `list` with the fields in `item`. **Paint on the model:** a `selection`.
- **Say what you can take:** `limits` on the operation (`max_input_triangles`, `max_output_triangles`, `max_memory_mb`). A texture can multiply the triangle count; the engine stops a result over your limit with a clear error and keeps the step before it.
- **Say what you promise:** `outputs.closed: true` when your result is closed if your input was. The engine checks it.
- **Report progress** with stage names listed in `stages`, and look at `ctx.signal` regularly, also inside long loops: cancelling waits 1.5 s and then ends the worker.
- **Same inputs, same mesh.** The cache key is built from the parameters and the content of the assets, so a plugin must not depend on anything else (time, random numbers without a fixed seed).
- **Say which parts you make and which you drop:** `outputs.segments` and `outputs.groups` (a name, or `{ param }` when a parameter names it) and `outputs.drops` (`"segments"` / `"groups"` for every part of that kind, `{ "param": "part" }` for the one part a `part` parameter names, `{ "param": "part", "keep": true }` for every other part of its kind). The editor uses them to warn, before anything runs, that a later step names a part no earlier step makes or one that was dropped. Panel sections are `sections` (a parameter names its section with `section`); they are not the mesh's groups.

## Drawings and stored items

A step takes and returns a **mesh** by default. Two things go beyond that. Both are checked by the engine, so a plugin never validates them.

- **Another kind in or out.** `"payload": { "in": "drawing", "out": "mesh" }` on an operation says it takes a flat drawing and returns a mesh (an extrusion). A generator says only `out`. A drawing is `{ kind: 'drawing', paths: [{ points: [[x, y], ...], closed, segment? }], segments?, fillRule? }` in millimetres, y up, curves already flattened. Read it as `ctx.payload`, return it as `{ payload }`. Details: `docs/payload-kinds.md`.
- **A second input next to the mesh.** A parameter `{ "name": "shape", "type": "payload", "accept": ["drawing"], "default": null }` takes the name of an item stored in the project. The engine finds it, checks its kind and shape, and gives it as `ctx.payloads.shape`. Editing the stored item re-runs only this step and the ones after it. A step that needs the item throws `{ code: 'myplugin.no_shape', params: {} }` when `ctx.payloads.shape` is missing (the setting is `null`).

A plugin cannot list or write the store: it only receives what its own settings name. The `store` and `load` operations belong to the host.
