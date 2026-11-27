# AtelierMesh Plugin & Workflow Spec (draft 0.1)

Status: draft for discussion. Date: 2026-10-09.
Goal: a host-agnostic standard for web apps that generate or transform 3D-printable files. Users build a **workflow** (an ordered, editable list of steps, as in a CAD feature history). Each step is a **plugin** described by a **manifest**. Editing any step re-runs the workflow from that step onward.

Design inputs: BumpMesh (parameter richness, preview/export split, project file), a slicer's plugin preview (manifest + declarative params + sandbox + signing), OpenSCAD customizer / JSCAD (parameter schemas), MCP (agent access). See "Prior art" at the end.

Normative words: MUST, SHOULD, MAY as in RFC 2119.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Host** | The app that loads plugins, renders the UI, runs the workflow, and exports files. |
| **Plugin** | A package: `manifest.json` + code + optional assets. Provides one or more **operations**. |
| **Operation** | One callable unit inside a plugin (for example `extrude`, `texturize`). Declares params, inputs and outputs. |
| **Step** | An instance of an operation inside a workflow, with concrete param values. |
| **Workflow** | An ordered list of steps (a linear pipeline in v1; a DAG is reserved for later). |
| **Mesh** | The common geometry type passed between steps (section 5). |
| **Asset** | A binary resource (texture image, font, STL) referenced by a param or stored in the project. |

## 2. Workflow model

### 2.1 Behaviour
- A workflow is a list of steps. Step N receives the mesh output of step N-1. The first step MAY be a **generator** (no mesh input).
- Every step can be edited (params), reordered, disabled, duplicated, deleted, or have a step inserted before/after it.
- Any change re-runs the workflow **starting at the earliest changed step**. Earlier results are reused from cache.
- A step can be **suppressed** (skipped, input passes through unchanged) and a **rollback marker** can be placed so the user views the result "as of step K" without deleting later steps (as in CAD).
- Step errors stop the run at that step. Earlier results remain visible, the failing step is flagged, and later steps are marked stale.

### 2.2 Caching
The cache key of step N is `hash(plugin.id, plugin.version, operation, canonical(params), asset hashes, hash(input mesh))`. If the key is unchanged the cached output is reused. Hosts SHOULD keep at least the last output per step in memory and MAY persist caches in IndexedDB.

### 2.3 Example (user-facing)
```
1. Extrude        profile: circle d=40, height=10 mm
2. Fillet         edges: top, radius=2 mm
3. Texturize      texture: "knurl", amplitude=0.4 mm, projection=cylindrical
4. Decimate       target: 500k triangles
5. Export         format: 3mf
```
Changing the height in step 1 re-runs steps 2 to 5. Changing the amplitude in step 3 re-runs 3 to 5.

### 2.4 Step kinds
| Kind | Mesh in | Mesh out | Examples |
|---|---|---|---|
| `generator` | no | yes | primitive, extrude, text, lithophane, heightmap to mesh |
| `modifier` | yes | yes | texturize, fillet, boolean, scale, decimate, repair |
| `analyzer` | yes | no (passes input through) plus a report | watertight check, volume, size report |
| `exporter` | yes | file | STL, 3MF, OBJ |

Boolean-style operations that need a second mesh take it from a mesh-typed param (section 4.3), which points at another step's output or an imported asset.

### 2.5 Parameter linking (v1.1, reserved)
A workflow MAY define named **variables** (`wall = 2.0`). Step params can bind to a variable instead of a literal. v1 hosts MAY omit this, but the project format reserves the `bindings` field.

### 2.6 Apply permanently
`applyPermanently(upTo?)` bakes steps into the base mesh. With no argument it applies all steps. With a step id it applies that step and every step before it; the steps after it stay in the list and now run on the new base. The editor then shows the result as a fresh model. There is no revert.
- **What runs:** the enabled steps from the first up to and including the chosen one, with the same plugin code as normal editing. Suppressed steps in that range are dropped. The result replaces the base mesh, and the applied steps are removed from the list.
- **Failure:** if any step in the range fails, nothing changes.
- **Rollback marker:** nothing after the marker can be applied. With a marker set, `applyPermanently()` (all steps) and any `upTo` step after the marker are refused (`apply.after_rollback`); only the marker's step and the steps before it can be applied. The user sees exactly what gets baked. After applying up to the marker's own step the marker is cleared (the later steps show again); if the marker lies after the applied range it is kept.
- **Undo history:** cleared, because nothing before this point can be restored.
- **Confirmation:** the host MUST ask "This cannot be undone" before calling it. The engine does not ask.
- **Availability:** `canApplyPermanently(state, upTo?)` is false when the list is empty, the step is unknown, or the step lies after the marker. The host may also block it (for example while a step in the range is marked `personalisable`). The host decides this, not the plugin.
- **Result:** the new base is read through the normal export (single-mesh 3MF, mm, segments kept). Apply adds no format.
- **Event:** the engine emits `base-replaced` (with the number of steps applied) so the host can save. AtelierMesh never talks to a server.
- **Standalone project file (§7):** `project.json` keeps only the remaining steps; the new base is stored in `inputs/`, and the old original is not kept.

## 3. Plugin package

```
my-plugin/
  manifest.json        required
  main.js              entry (ES module), runs in a Worker
  assets/              textures, fonts, sample meshes (read-only)
  presets/*.json       optional
  locales/<lang>.json  optional: the plugin's texts, one file per language (section 3.1)
  README.md, LICENSE
```
Distribution: a ZIP named `<id>-<version>.amplugin`. A signed package adds `manifest.sha256` and `manifest.sig` (section 8).

### 3.1 Texts of a package (`locales/<lang>.json`)

A package carries its own texts, so labels, hints, option names and problem messages show in the user's language. The loader reads them (`LoadedPackage.locales`) and the host merges them into its translation function. They are part of the package files: they are in `manifest.sha256`, covered by the signature, and kept with the stored package, so a host that keeps packages (the standalone, in IndexedDB) has them again after a restart without storing them twice.

**Files.** Only files named `locales/<lang>.json` count, with `<lang>` a language code of 2 or 3 lower-case letters and an optional region (`en`, `nl`, `fr`, `nl-BE`, `pt-BR`). Any other file in `locales/` is ignored. At most 8 language files, each at most 64 KB. A file is one JSON object whose values are objects (nested at most 6 levels) or plain strings; at most 2000 strings in all, each at most 1000 characters. A package that breaks a limit, is not JSON, or holds a value that is not text (a number, an array) is refused with `loader.invalid_package` (`locale_too_many_files`, `locale_too_large`, `locale_not_json`, `locale_not_an_object`, `locale_not_text`, `locale_too_deep`, `locale_too_many_texts`, `locale_text_too_long`). A key part is 1 to 60 characters of `A-Z a-z 0-9 _ -`.

**Text only.** A text is a plain string with `{{placeholder}}` slots filled from the problem's numbers. It is never read as markup: a host shows it as text (React or `textContent`), and the loader strips nothing and injects nothing.

**Namespace rule.** A package may only add or replace the keys of its own plugin; every other key is left out (not an error, listed in `LoadedPackage.locales.ignored` with the reason `outside_namespace`, `bad_key` or `not_a_language_file`). Keys, in nested form (`mesh.mirror.empty`) or as the dotted path:

| Key | Allowed when |
|---|---|
| `ops.<op>.…` (title, sections, params, options) | `<op>` is one of the plugin's own operation ids |
| `step.op.<op>` (the step's name in the list and the menu) | `<op>` is one of its own operation ids (exactly this key) |
| `mesh.<prefix>.…` (a problem text: `mesh.<code>`, `mesh.<prefix>._any`, a variant such as `mesh.<code>_turn`) | `<prefix>` is one of its own operation ids, or the last part of the plugin id (`com.example.lithophane` gives `lithophane`) |

So a plugin can never change the app's chrome (`panel.*`, `fix.*`, `addStep.*`, `plugin.*` and so on), the built-in plugins' texts, or the texts of another plugin. The host adds two guards (`PluginTexts` in `@ateliermesh/core`, `makeT` in the demo and standalone): a package text is only used for a key the host's own English file does not have, and a namespace root (`ops.<op>`, `step.op.<op>`, `mesh.<prefix>`) belongs to the first plugin installed that uses it (the later plugin's keys for it are left out and listed by `ignoredFor`). Removing or unloading a plugin removes its texts.

**Order of lookup** for a text key: the app's own language file, then the package's text in the chosen language (a host that supports regions tries `nl-BE`, then `nl`), then the English of each in the same way, then the English written in the manifest (`label`, `help`, option `label`, `title`), then the key itself.

### 3.2 Warnings and errors from a plugin

A plugin reports a problem in one of two ways, and the way decides how serious it is (the design rule `warning = in the step's report, error = thrown`). A `{ code, params }` in the `warnings` array of the run result is a **warning**: the step ran, the result is usable and is not blocked (the person can go on and export). A problem thrown (`MeshError`, or a plain `{ code, params }` object) is an **error**: the step has no result, the host keeps the last good result and disables saving. The host does not need a list of a plugin's codes: `describeProblem(code, params, { channel })` in `@ateliermesh/ui` takes the channel. A code from the warnings array is a non-blocking warning, even when the host has never heard of it; the same code thrown is an error. A host's own list of built-in codes still wins: its information codes (`run.cancelled`, `emboss.text_scaled_to_fit`, ...) stay information, and a built-in warning stays a warning when it is thrown. A plugin has no way to mark a code as information; that needs a manifest field and was left out because the channel covers every case so far. The text of a problem is `mesh.<code>` (section 3.1).

## 4. Manifest

### 4.1 Top level
```jsonc
{
  "$schema": "https://ateliermesh.dev/schema/manifest-1.json",
  "manifest_version": 1,
  "id": "com.example.texturize",          // reverse-domain, required
  "name": "Surface Texturizer",
  "version": "1.2.0",                      // semver
  "description": "...",                    // REQUIRED for external packages and built-in plugins: plain text, 10 to 300 characters
  "author": "...", "license": "MIT",       // license REQUIRED (same rule): SPDX id or "Proprietary", 1 to 64 characters
  "contact": { "url": "https://...", "email": "...", "name": "..." },   // optional; url is https only; shown as text and links
  "package_url": "https://.../plugin.amplugin",   // optional: where the packed file can be fetched again (https, no credentials, 300 characters)
  "replaces": ["org.old.name"],                  // optional: ids this plugin replaces (up to 8): a step saved with one of them runs with this plugin
  "image": { "file": "assets/example.png", "alt": "..." },   // optional: example picture for the plugin gallery (PNG/JPEG/WebP by content, <= 300 KB, 200..1600 px wide, <= 1200 px high; alt 5..160 characters)
  "icon": "spline",                        // optional: an icon name for the plugin as a whole; a plugin with one and three or more operations in a menu group becomes one submenu row
  "homepage": "...", "repo": "...",
  "host": { "api": "1", "min": "0.1.0", "max": null },  // enforced
  "permissions": [],                       // section 8, default none
  "uses": [],                               // host services the plugin calls: "fonts" = ctx.fonts.outline(...); a host without one refuses the step (plugin.needs_fonts)
  "limits": { "max_triangles": 10000000, "max_memory_mb": 1024, "timeout_s": 300 },
  "entry": "main.js",
  "operations": [ /* section 4.2 */ ]
}
```
**Renamed plugins (`replaces`).** A plugin published under a new id lists the old ids in `replaces`. A host that has the plugin and not the old id MUST run a step saved with an old id with this plugin: the step's plugin id becomes the new one, the stored version stays, and the plugin's `migrate(from, params, op)` and `migrateOp` get that stored version (so the new version must be higher than the highest old one; otherwise the step stops with `step.version_newer`). An id that is itself installed is never renamed. When two installed plugins replace one id, the first registered answers. A project that is opened gets the new id at once; a plugin installed while it is open renames its steps then. The reference engine offers `registry.canonicalId(id)`, `applyRenames(list, registry)` and `renamedFrom` on a step result. A catalog entry shows the field (section 4B), so a host can say which plugin replaces a missing one.

A package from outside (an `.amplugin`) and every built-in plugin MUST carry `license` and `description`; the host MUST refuse a package without them, with a message that says what to add. `contact` and `package_url` are optional; a host MUST show them as text (never as markup), link only an https `contact.url` (opening it in a new tab with `rel="noopener noreferrer"`), build a mail link only from a validated `contact.email`, and fetch `package_url` only when the person asks for an update (never in the background), asking before the new package replaces the installed one. Error codes: `manifest.missing_license`, `manifest.missing_description`, `manifest.bad_license`, `manifest.bad_description`, `manifest.bad_contact`, `manifest.bad_package_url`.

The host MUST reject a manifest that fails schema validation, requests an unknown `host.api`, or whose version range excludes the host. Unknown extra fields MUST be ignored (forward compatibility). Unknown `permissions` MUST cause rejection.

### 4.2 Operation
```jsonc
{
  "id": "texturize",
  "title": "Texturize surface",
  "kind": "modifier",                      // generator | modifier | analyzer | exporter
  "icon": "assets/icon.svg",
  "inputs":  { "mesh": { "required": true } },
  "outputs": { "mesh": true, "report": false },
  "importance": "normal",   // optional: "low" folds the operation into the Add a step menu's "More" group when the menu is long
  "payload": { "in": "mesh", "out": "mesh" },   // optional: the kind of thing it takes and returns; default mesh ('*' = any, only for the built-in `store`). See docs/payload-kinds.md
  "supports": { "preview": true, "cancel": true, "progress": true },
  "params": [ /* section 4.3 */ ],
  "sections": [ { "id": "projection", "title": "Projection", "collapsed": false } ],
  "stages": ["subdivide", "displace", "decimate"],   // for progress reporting
  "presets": "presets/texturize.json"
}
```

### 4.3 Parameter definition
Every param has:

| Field | Meaning |
|---|---|
| `name` | Stable key. Never shown. |
| `label`, `help` | Display text (localisable). |
| `type` | See table below. |
| `default` | Required. |
| `section` | The id of the panel section this parameter is shown in (one of the operation's `sections`). |
| `unit` | `mm`, `deg`, `%`, `px`, ... Host handles unit display. |
| `visible_if`, `enabled_if` | Conditional expression over other params (section 4.4). |
| `quality` | `"both"` (default), `"export"` (ignored in preview), or `"preview"`. |
| `affects` | Optional hint: `"geometry"`, `"appearance"`. Lets the host skip re-running for appearance-only changes. |
| `personalisable` | Whether this parameter can be made personalisable: handed to the end customer by the designer. The host's validator rejects a change to any other parameter when validating as the customer role. (Adopted from the Atelier's requirements note.) |

Parameter types:

| Type | Extra fields | UI |
|---|---|---|
| `bool` | | toggle |
| `int`, `float` | `min`, `max`, `step`, `scale: "linear"\|"log"`, `soft_min/soft_max`, `wheel_fine: true` | slider + number box (wheel fine-tune, log slider) |
| `string` | `multiline`, `pattern`, `max_length` | text |
| `enum` | `options: [{value,label,icon}]` | dropdown / segmented |
| `range` | `min`, `max`, `step` | two-handle slider (for example angle masks: min and max angle) |
| `vector` | `size: 2\|3`, `labels: ["X","Y","Z"]`, `lock_ratio` | linked number boxes |
| `angle` | `min`, `max`, `wrap` | dial or slider |
| `color` | `alpha` | colour picker |
| `asset` | `accept: ["image/png","image/jpeg"]`, `library: "assets/textures/"`, `allow_upload`, `categories`, `searchable` | gallery with search, favourites, upload |
| `mesh` | `source: "previous"\|"step"\|"asset"` | step picker / file |
| `payload` | `accept: ["drawing"]` (kinds; `*` = any), value = a name in the project store or `null`; the plugin gets `ctx.payloads[<name of the parameter>]` | picker of stored entries (docs/payload-kinds.md, "The project store") |
| `selection` | `entity: "face"\|"edge"\|"vertex"\|"body"`, `modes: ["pick","brush","bucket","angle","box"]` | in-viewport selection or paint tool (section 4.5) |
| `transform` | `fields: ["translate","rotate","scale"]`, `pivot` | gizmo + number boxes |
| `part` | `kinds`, `allow_empty` (default true: empty means the whole mesh) | choose among the segments and groups the mesh has at this step; the value is the name, checked when the step runs |
| `placement` | `up_ref: "z"\|"y"\|"x"`, `limits` (distance, direction range) | click on the mesh, direction handle, number boxes (section 5A.7) |
| `list` | `item: <param set>`, `min_items`, `max_items`, `item_title`, `reorderable` | repeatable rows (for example texture layers) |
| `object` | `fields: [<param>]` | nested fields held as one value |
| `curve` | `points`, `domain`, `range` | curve editor (for example falloff) |

### 4.4 Conditions
`visible_if` / `enabled_if` use a small, safe expression language (no code execution): comparison and boolean operators over param names, for example `"projection == 'planar' || use_mask"`. The host evaluates them; plugins never ship UI code.

### 4.5 Selections and masks (BumpMesh-style painting)
A `selection` param stores a **mask** independent of mesh topology so it survives re-runs: a list of regions defined by `{ mode, geometry-relative data }`, for example `{ "mode":"angle", "normal":[0,0,1], "min":0, "max":30 }`, `{ "mode":"brush", "triangles": [...] }`, or `{ "mode":"box", "min":[..], "max":[..] }`. Topology-dependent selections (brush, bucket) carry a fingerprint of the input mesh. If the input mesh changes, the host warns the user and plugins receive `mask.stale = true`.

### 4.6 BumpMesh parity example
This shows the manifest can express what BumpMesh offers today: up to four texture layers, each with its own mask and projection, plus global angle masks and export-quality settings.

```jsonc
{
  "id": "texturize",
  "kind": "modifier",
  "stages": ["subdivide", "displace", "decimate"],
  "sections": [
    { "id": "layers", "title": "Texture layers" },
    { "id": "mask",   "title": "Surface masks" },
    { "id": "export", "title": "Output quality" }
  ],
  "params": [
    { "name": "layers", "type": "list", "section": "layers", "min_items": 1, "max_items": 4,
      "item_title": "Layer {index}", "reorderable": true,
      "item": [
        { "name": "texture", "type": "asset", "label": "Texture",
          "accept": ["image/png","image/jpeg"], "library": "assets/textures/",
          "categories": true, "searchable": true, "allow_upload": true },
        { "name": "projection", "type": "enum", "default": "triplanar",
          "options": [{"value":"triplanar","label":"Triplanar"},{"value":"cubic","label":"Cubic"},
                      {"value":"cylindrical","label":"Cylindrical"},{"value":"spherical","label":"Spherical"},
                      {"value":"planar","label":"Planar"}] },
        { "name": "blend_mode", "type": "enum", "default": "add",
          "options": [{"value":"add","label":"Add to layers below"},{"value":"cover","label":"Cover layers below"}] },
        { "name": "scale",    "type": "vector", "size": 2, "default": [10,10], "unit": "mm", "lock_ratio": true, "wheel_fine": true },
        { "name": "offset",   "type": "vector", "size": 2, "default": [0,0],  "unit": "mm" },
        { "name": "rotation", "type": "angle",  "default": 0, "unit": "deg" },
        { "name": "amplitude","type": "float",  "default": 0.4, "min": 0, "max": 5, "scale": "log", "unit": "mm", "affects": "geometry" },
        { "name": "symmetric","type": "bool",   "default": false, "help": "50% grey is neutral" },
        { "name": "seam_blend","type": "float", "default": 0.2, "min": 0, "max": 1,
          "visible_if": "projection == 'cylindrical' || projection == 'spherical'" },
        { "name": "mask", "type": "selection", "entity": "face",
          "modes": ["pick","brush","bucket","angle"] }
      ] },
    { "name": "top_angle",    "type": "range", "section": "mask", "unit": "deg", "min": 0, "max": 90, "default": [0,0], "label": "Top-face exclusion" },
    { "name": "bottom_angle", "type": "range", "section": "mask", "unit": "deg", "min": 0, "max": 90, "default": [0,0], "label": "Bottom-face exclusion" },
    { "name": "crease_angle", "type": "float", "section": "mask", "unit": "deg", "default": 30, "min": 0, "max": 90 },
    { "name": "target_triangles", "type": "int", "section": "export", "default": 750000, "min": 1000, "max": 10000000, "scale": "log", "quality": "export" },
    { "name": "max_edge", "type": "float", "section": "export", "unit": "mm", "default": 0.5, "min": 0.05, "max": 5, "scale": "log", "quality": "export" }
  ]
}
```
Features BumpMesh has that the manifest covers: layered textures with per-layer mask and projection (`list` + `selection`), gallery with search and upload (`asset`), log sliders and wheel fine-tuning (`float.scale/wheel_fine`), angle masks (`range`), painting tools (`selection.modes`), conditional controls (`visible_if`), separate export quality settings (`quality: "export"`), stage progress (`stages`). Not covered by the manifest (host features): undo/redo, theming, language, 6-DoF controllers, section view.

### 4.7 Presets
A preset is a JSON object of param values for one operation, `{ "name": "...", "values": { ... } }`. Hosts MUST allow users to save, load and share presets, and to apply a preset to an existing step.

## 4B. Plugin catalog (format `ateliermesh-catalog`, version 1)
A catalog is a list of plugin packages a host can search and install from. It is optional: a host without one works the same. A catalog is plain JSON: anyone can serve it from anywhere (a static file will do).

```json
{
  "format": "ateliermesh-catalog",
  "version": 1,
  "generated": "2026-11-09T10:00:00+00:00",
  "plugins": [
    {
      "id": "com.example.mirror",
      "name": "Mirror",
      "description": "Mirrors a model along an axis so both halves match.",
      "license": "MIT",
      "contact": { "name": "Example Ltd", "url": "https://example.org/mirror", "email": "hello@example.org" },
      "image": { "url": "catalog.php?image=com.example.mirror&v=1.2.0", "alt": "A mirrored vase" },
      "latest": "1.2.0",
      "downloads": 1304,
      "versions": [
        { "version": "1.2.0", "url": "catalog.php?download=com.example.mirror&v=1.2.0", "sha256": "<64 hex>", "size": 5120, "uploaded": "2026-11-09T09:58:00+00:00", "signed": false, "downloads": 1240 },
        { "version": "1.0.0", "url": "packages/com.example.mirror/1.0.0.amplugin", "sha256": "<64 hex>", "size": 4980, "uploaded": "2026-10-01T12:00:00+00:00", "signed": true, "downloads": 64 }
      ]
    }
  ]
}
```
- Plugins sorted by name; `versions` newest first by semantic version; `latest` is the newest and must be in `versions`.
- `id`, `name`, `description`, `license`, `contact`, `image` come from the newest version's manifest (same rules as section 4). `image` is optional; its address is relative to the catalog's own address or absolute on the same host.
- `url` is relative to the catalog's address (or absolute https). `sha256` is of the package file; `size` is its length in bytes. `signed` says the package carries a signature file; it does not say whose: the host decides that from the keys its user trusts.
- `replaces` (optional, on a plugin) lists the ids the plugin replaces, as in its manifest (section 4); the document may also carry `renames`, an object from each old id to the plugin that replaces it, made from those lists by the catalog (an id that is itself a plugin of the catalog is left out). A host shows `replaces` and uses it to say which plugin replaces a missing one; it never renames anything because of the catalog alone: the rename happens when the plugin is installed and its own manifest says so.
- `downloads` (a whole number, optional, on a plugin and on a version) is how many times the catalog served the package: public, counted by the catalog, not by the host. A plugin's number is the sum over its versions. A host shows it when it is present and a whole number of at least 1, and treats anything else as absent. The PHP catalog counts a download made through its address `catalog.php?download=<id>&v=<version>` (the `url` of a version); a direct link to a file in `packages/` still works and is not counted. It counts requests, not people: updates, re-installs and robots are in it, and so are installs the person then cancels. Nothing about the downloader is kept.
- A host MUST treat everything in a catalog as untrusted text: show it as text, accept only https addresses (or addresses on its own site), and read a package it downloads exactly like a file the person chose: the checksum must equal `sha256`, the manifest's `id` and `version` must equal the entry's, and the usual checks, signature rules and approval apply. A host MUST NOT install, update or fetch anything from a catalog without the person's action, and SHOULD read a catalog only when the person opens the place that shows it.
- A host SHOULD mark an installed plugin whose id is in the catalog with a `latest` newer than the installed version as "update available", offering the same approval as a first install ("installed -> new").
- Servers: `Cache-Control: no-cache`; CORS only when other sites are meant to read it.

## 5. Mesh interchange type

```ts
interface Mesh {
  positions: Float64Array;     // xyz, length = 3 * vertexCount, millimetres, right-handed, Z up
  indices:   Uint32Array;      // 3 per triangle
  groups?:   { start:number, count:number, role:'solid'|'negative', name?:string, color?:string }[];   // separate bodies (contiguous index ranges); `color` is #rrggbb
  segments?: { labels: Uint16Array, table: { id:number, name:string, color?:string }[] };   // labels the triangles of ONE surface; see 5.1
  meta?:     { watertight?:boolean, shells?:number, bbox:[number,number,number,number,number,number] };
}
```
There are no textures, no UV coordinates, no per-vertex colours and no per-vertex normals in the type. Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.

Rules:
- Indexed and welded. Hosts provide a shared weld/quantise helper so plugins do not each implement it.
- Passed between host and Worker via **transferable** buffers.
- `groups[].role` is `solid` or `negative` (a negative group is subtracted). Exporters that cannot represent roles (STL) merge `solid` groups and drop others, with a warning.
- Non-indexed input from importers is welded by the host before reaching plugins.

### 5.1 Segments

A **segment** is a named set of triangles of the mesh. `segments.labels` has one entry per triangle; `table` names the labels. Label 0 is the default segment, named `body`. A triangle has exactly one label.

Rules (decided):
- **Any operation may add or change segments.** For example `emboss` adds a segment `emboss` for the letter triangles; a future `select_by_angle` or `select_by_region` operation only labels triangles and changes no geometry. A segment name is chosen by a parameter of the operation (default: the operation's own name) and must be unique in the mesh; reusing a name replaces the earlier segment.
- **A later operation may be limited to one segment.** An operation that supports it has a parameter of type `part` (usually named `segment`, `kinds: ["segment"]`, default `""` meaning the whole mesh). It then reads and changes only the triangles of that segment. This is how "texturize only this part" works.
- **Operations must carry the labels through.** An operation that keeps the triangles (move, scale, rotate) keeps `segments` unchanged. An operation that creates triangles (emboss, decimate, subdivide) gives each new triangle the label of the triangle it came from. An operation that cannot do this MUST drop `segments` and report a warning `segment.dropped`; a later step that names a segment then fails with `segment.unknown`.
- **Edges between segments:** an operation limited to a segment keeps the vertices on the segment's border where they are (or fades the change to zero over a distance given by a parameter), so the surface stays closed and without cracks.
- **Colour:** Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export. A segment colour wins over the colour of the body its triangle is in; the default segment `body` can carry a colour too (the layer below the body colour). A colour that is not `#rrggbb` is refused: `segment.bad_color` (from the helpers), `plugin.bad_mesh` (from a plugin result). Helpers: `assignSegment(mesh, name, flags, color?)`, `setGroupColor(mesh, name, color)`, `setSegmentColor(mesh, name, color)`, `colorSegments(mesh, { name: color })`.
- **Export:** an exporter maps each segment to a colour and, for slicers, to an extruder number through a palette given as an export parameter (see `docs/3mf-colour.md`). In 3MF a body colour becomes a colour of its own named after the body, and a segment colour wins over it. A format with no colours (STL) ignores them. On import, 3MF colours become group colours (one colour per object), the colour of the default segment (a single-object file with one colour), or segments `material_1`, `material_2` ... (several colours in one object); at most 64 colours, more are reduced to the nearest of 64 with the warning `import.colours_reduced`.
- `groups` (contiguous ranges with a role) stay for separate bodies, such as a `negative` volume. Segments are for labelling one surface.

## 5A. Core operations (built-in plugin `org.ateliermesh.core`)

This is the catalogue of operations whose names and parameters the standard reserves. A host or package ships only the operations it needs. This project builds `scale` (called `resize` in the Atelier's plan), `emboss`, `rotate`, `auto_orient`, `overhang` and `decimate`; `printability` and `thickness` are kept as TBD. An operation that is shipped MUST use the names, parameters and behaviour in this section so projects stay portable, and MAY be implemented natively by the host, using the same manifest format as any third-party plugin. The operations give plugins a common vocabulary (for example, "place on face, then texturize").

### 5A.1 Interactive tools
Some operations are driven in the viewport rather than by typing numbers. An operation declares this with `"tool"`:
```jsonc
"tool": { "gizmo": "rotate", "pick": null }        // drag handles in the viewport
"tool": { "gizmo": null,     "pick": "face" }      // click a face
```
A tool only fills in param values. When the user confirms, the result is an ordinary step with plain params, so it is editable, reorderable and re-runnable like any other. Tools never store viewport state, only params.

### 5A.2 Reference frame and pivots
- Core operations work in **world space**: millimetres, right-handed, Z up, the build plate is Z = 0.
- Every transform has a `pivot`: `"bbox_center"` (default), `"bbox_bottom_center"`, `"origin"`, `"centroid"`, or `{ "point": [x,y,z] }`.
- Consecutive transform steps MAY be merged by the host into one matrix as an optimisation. This MUST NOT change the result.

### 5A.3 Operation catalogue (v1)

Status marks: **Planned** = built by this project; **TBD** = kept as a reserved name, not decided; unmarked = reserved name only.

**Import** (generators; input is an asset)
| Op | Params |
|---|---|
| `import_mesh` | `file` (asset: STL, OBJ, 3MF, STEP), `step_quality` (`coarse`/`standard`/`fine`, STEP only), `units` (`mm`/`inch`/`m`, default `mm`), `weld_tolerance` |

**Position and orientation** (modifiers)
| Op | Params | Notes |
|---|---|---|
| `move` | `offset` (vector 3, mm), `mode` (`relative`/`absolute`) | Gizmo tool. |
| `rotate` | `angles` (vector 3, deg), `order` (`XYZ` default), `pivot`, `snap_step` (deg, optional) | Gizmo tool with snapping. |
| `scale` | `factor` (vector 3), `uniform` (bool), `mode` (`factor`/`target_size`), `target_size` (vector 3, mm), `pivot` | |
| `mirror` | `plane` (`XY`/`XZ`/`YZ`), `keep_original` (bool) | |
| `center` | `axes` (`XY`/`XYZ`), `on` (`bbox`/`centroid`) | |
| `drop_to_bed` | `z` (default 0), `margin` (mm) | Moves the mesh so its lowest point sits on the plate. |
| `place_on_face` | `face` (selection, `entity: "face"`, `modes: ["pick"]`), `target` (`bed`/`plane`), `plane` (point + normal, used when `target = "plane"`), `spin` (angle about the face normal, deg), `then_drop` (bool, default true) | Pick tool. See 5A.4. |
| `auto_orient` | `goal` (`min_support`/`min_height`/`max_stability`), `candidates` (int), `overhang_angle` (deg, default 45) | **Planned.** Geometric analysis, no printer data; reuses the `overhang` measure. The result is stored as `rotate` params in the report so the user can apply it as a step. |
| `align` | `axis`, `to` (`min`/`center`/`max`), `reference` (mesh param) | Aligns to another mesh or the bed. |

**Edit**
| Op | Params |
|---|---|
| `cut_plane` | `plane` (point + normal), `keep` (`above`/`below`/`both`), `cap` (bool), `connectors` (none/pins) |
| `split` | `mode` (`shells`/`plane`), `plane` |
| `boolean` | `operation` (`union`/`difference`/`intersection`), `other` (mesh param), `tolerance` |
| `hollow` | `wall` (mm), `drain_holes` (list of positions + diameter) |
| `offset` | `distance` (mm, signed) |
| `array` | `kind` (`linear`/`circular`/`grid`), `count`, `spacing` or `angle`, `axis` |
| `merge` | `others` (list of mesh params), `arrange` (`none`/`pack`) |
| `emboss` ("Text on the surface") | `text`, `font`, `weight`, `align`, `spacing`, `line_spacing`, `size`, `max_width`, `mode` (`raised`/`engraved`/`flat`), `height` (not when flat), `placement`, `segment` (top, floor or flat area, default `text`), `walls_segment` (side walls, default `text_walls`, empty = same part as `segment`), `min_stroke`, `min_wall`. See 5A.7. The old `source` is accepted and ignored. |
| `emboss_svg` ("SVG on the surface") | `shape` (a `payload` setting: the name of a **drawing** in the project store; closed paths are filled by the drawing's rule, open paths are left out), `size`, `max_width`, then the same `mode`, `height`, `placement`, `segment`, `walls_segment`, `min_stroke`, `min_wall` as `emboss`. Both run on one engine. |

An SVG file is turned into a drawing once, when it is imported (`svgToDrawing(svg, { mode: 'fill' | 'line' })` in `@ateliermesh/plugins`: curves flattened, millimetres, y up, 100 mm tall; `fill` keeps the filled areas, `line` the strokes at their width). The step never reads SVG. Since `org.ateliermesh.core` 0.4.0 the `svg` and `svg_mode` settings are gone; an older stored step is migrated with an empty `shape` (the error code for that is `emboss.no_shape`, replacing `emboss.no_svg`).

**Mesh quality**
| Op | Params |
|---|---|
| `subdivide` | `max_edge` (mm), `crease_angle` (deg), `max_triangles` |
| `decimate` | `mode` (`quality`, the default: as small as possible within `tolerance` mm; or `target`: `target_triangles`, with an optional `max_error`; core 0.3.0, older steps migrate to `target`), `preserve_boundary`, `preserve_creases`, `crease_angle`. **Planned.** Reduces the triangle count, keeps boundaries and sharp creases, and reports the largest surface error |
| `smooth` | `iterations`, `strength`, `preserve_features` |
| `repair` | `weld`, `fill_holes` (`max_hole_size`), `fix_normals`, `remove_degenerate`, `remove_small_shells` (`min_volume`) |

**Generate** (generators)
| Op | Params |
|---|---|
| `primitive` | `shape` (`box`/`cylinder`/`sphere`/`cone`/`torus`), `size`, `segments` |
| `extrude` | `profile` (sketch or shape), `height`, `taper_angle`, `both_sides` |
| `revolve` | `profile`, `angle`, `axis` |
| `text` | `text`, `font` (asset), `size`, `depth`, `spacing` |
| `heightmap` | `image` (asset), `size`, `max_height`, `base_thickness`, `invert` |

`extrude` and `revolve` need a `sketch` param type, which is open question 4 in section 12. Until that is settled they take a simple built-in shape profile (circle, rectangle, polygon).

**Analyze** (pass the mesh through and attach a report)
| Op | Report |
|---|---|
| `inspect` | triangle count, shells, open edges, watertight flag, bounding box, volume |
| `overhang` | `angle` (deg, default 45) | **Planned.** Overhang area beyond an angle, with a viewport overlay. `auto_orient` reuses its measure |
| `thickness` | `threshold` (mm) | **TBD.** Thin-wall regions below a threshold, with a viewport overlay |
| `printability` | thresholds given as parameters | **TBD.** One combined report: small features, overhangs with an estimated support volume, and a suggested orientation. The report format is the Atelier's. No printer data is built in |

**Export** (exporters). **`export_3mf` is the default export format** of a host that has no other requirement; `export_stl` stays available for hosts and slicers that need it.
| Op | Params |
|---|---|
| `export_stl` | `format` (`binary`/`ascii`), `filename` |
| `export_3mf` (default) | `filename`, `units` (default `mm`), `include_roles` (bool), `embed_thumbnail` |
| `export_obj` | `filename` |

**3MF colour.** Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export. What is written, what is read and the option values for slicers: `docs/3mf-colour.md` and `docs/3mf-parts.md`. The colour slots of a design survive a 3MF written by AtelierMesh (the first slot is the segment `body`, the others `slot_<id>`, two slots of one colour stay two): `docs/3mf-colour.md` section 4b.

### 5A.4 Place on face
`place_on_face` is the reference interaction, because the user picks something on a mesh that an earlier step may later change.

- The `face` param stores a **geometric reference**, not a triangle index: `{ "point": [x,y,z], "normal": [nx,ny,nz], "tri_hint": 1234, "fingerprint": "..." }` in the coordinates of the step's input mesh.
- On each run the host resolves the reference in this order: (1) if `fingerprint` matches the input mesh, use `tri_hint` directly; (2) otherwise find the triangle nearest `point` whose normal is within `normal_tolerance` (default 10°); (3) otherwise fail the step with the message "face reference could not be resolved" and flag the step.
- The operation aligns the face normal with the target (`bed` means -Z), applies `spin` about that normal, then drops the mesh onto the plate if `then_drop` is true.
- The picker SHOULD select a whole coplanar region (within an angle tolerance), as BumpMesh-style tools do, so a click on one triangle of a flat face selects the whole flat.
- Because the reference is geometric, upstream edits that move or rotate the mesh keep working when the host also transforms the reference. Hosts MUST transform stored references when a user edits an earlier `move`/`rotate`/`scale` step. Edits that change topology fall back to step (2) above.

### 5A.5 Typical workflows
```
import_mesh → place_on_face(face=bottom) → texturize → export_3mf
extrude(circle d=40, h=10) → hollow(wall=2) → rotate(x=90) → drop_to_bed → inspect → export_stl
import_mesh → center → scale(target_size=[100,_,_]) → array(linear, 4) → merge → export_3mf
```

### 5A.6 Acceptance for core operations
The conformance suite (section 11) MUST include, for each core operation, a small input mesh, params, and the expected output within a tolerance (default 1e-4 mm for vertex positions after sorting).

### 5A.7 Surface placement and `emboss`

*Added 2026-11-07, revised the same day. Draft. Pictures: `PROJECTION-EXPLAINED.html`.*

**Placement** says where something starts on the mesh and which way it starts to point. It is a param type, so any operation can use it.

| Field | Meaning |
|---|---|
| `anchor` | A point on the surface, the surface normal there, a triangle hint and a mesh fingerprint (the geometric reference of 5A.4), in the coordinates of the step's input mesh. The host transforms it when an earlier move, rotate or scale step changes, and re-resolves it by nearest triangle and normal when the topology changes |
| `up_ref` | Which axis counts as "up" for the content: `z` (default), `y` or `x` |
| `direction` | Angle in degrees, about the normal at the anchor, between the content's reading direction and the horizontal for `up_ref` at that point. Range −180 to 180. It sets the start only: away from the anchor the content follows the surface |
| `offset` | `[u, v]` shift in millimetres on the unfolded map (see below) |
| `align` | Which point of the content's box sits at the anchor |
| `limits` | Optional, set by the designer: maximum distance from the anchor, allowed direction range, allowed sizes. Hosts enforce them for the customer role |

The anchor decides only where the content starts and which way it starts to read. It does not fix the mapping or the lift: those follow the surface under each part of the content. When the normal at the anchor is parallel to the `up_ref` axis, the horizontal is undefined. The operation then falls back to world Y (or X if `up_ref` is Y) and reports that it did so.

**`emboss`** (and `emboss_svg`, which only differs in where the outlines come from) builds raised, engraved or flat content as part of the mesh itself: one mesh, no boolean, no raster image.
1. Text and font become outlines kept as SVG path data (or an SVG is the source).
2. Outlines become polygons: curves flattened at a fixed tolerance, each path's fill rule respected, everything merged with a non-zero union so overlapping letters and overlapping contours inside a glyph join into one shape.
3. **Unfold:** a patch of the mesh around the anchor (a band shaped like the text on gently curved surfaces, a disk on strongly curved ones) is unfolded into a flat map that keeps distances along the surface as true as possible. The anchor is the origin of the map and `up_ref` and `direction` set its axes at the anchor.
4. **Place:** the polygons are laid on the map using `offset` and `align`.
5. **Cut:** each flattened triangle maps to its 3D triangle by an affine map, so a straight outline segment inside it stays straight on the 3D triangle. The mesh triangles are split along the outlines and the outlines become mesh edges. The surface geometry does not change.
6. **Classify:** each piece is inside a letter or outside.
7. **Lift:** the inside is moved by `height` along the surface normal at each point (smoothed vertex normals), up for `raised`, down for `engraved`. Each outline vertex gets two copies, one that stays and one that moves, joined by wall triangles.
8. The report gives the text volume, the worst stretch of the letters, and warnings (outside the placement limits, too much distortion, over a corner). The operation fails, and outputs nothing, if the patch cannot be unfolded, if the text runs off it, or if engraving would pass through the wall behind it (checked by looking inward from each lifted point).
9. The output is one mesh: closed whenever the input was, with no new self-intersections.

The unfolded map depends only on the mesh, the anchor and the patch size, so a host may cache it. The result is a pure function of the mesh and the parameters. A flat surface is the trivial case: unfolding changes nothing. Doubly curved surfaces cannot be unfolded without some stretching, so the operation has a stretch limit (the M0 measurements suggest warning above 1.15 and refusing above 1.5, to be confirmed by a visual review). The letter tops copy the mesh's own facets, so a very coarse mesh gives faceted letters.

Suggested check data for the server side: the bounding box grows by at most `height` when raised and does not grow when engraved; the volume changes by at most text area × `height`.

### 5A.8 Low poly (plugin `org.ateliermesh.lowpoly`, operation `low_poly`)

An artistic reduction: the same surface made of few, large, flat facets. A modifier, `personalisable: 'never'`, stages `collapse` and `crystallise`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `triangles_mode` | enum `auto` / `fixed` | `auto` (a step stored before 0.2.0 migrates to `fixed`) | `auto`: the plugin finds the smallest triangle count that stays within a tolerance (see below). `fixed`: use `triangles`. Labelled "Amount" in the panel. |
| `detail` | float, 0 to 1 | 0.5 | Only in `auto`: how faithful the result stays. 0 is bold and artistic, 1 stays close to the original. |
| `triangles` | int, 12 to 200 000 | 2000 | Only in `fixed`: target number of triangles (split by size between bodies, at least 4 per body). |
| `sharpness` | float, 1 to 90 deg | 40 | Edges whose faces meet at more than this angle are held as creases. A lower angle holds more edges: a more faceted look. |
| `crystallise` | float, 0 to 1 | 0.5 | How far each free vertex moves towards the planes of the original surface around it. 0 is the plain reduction. |
| `keep_borders` | bool | true | Hold the outline of open borders. |

Automatic count: the collapse runs down to 12 triangles but stops when the next collapse would pass the tolerance `diagonal * (0.08 * (1 - detail)^2 + 0.002)`, where `diagonal` is the diagonal of the bounding box (detail 0: 8.2 % of it, 0.5: 2.2 %, 1: 0.2 %). The error is the decimator's quadric error, an estimate of the distance from the original surface. When held creases stop a pass early, up to eight more passes run, each limited to what is left of the tolerance, so the passes together stay within it. `sharpness` and `crystallise` apply as before. The report gives `mode`, `detail`, `tolerance` (mm) and `chosen_triangles`; `lowpoly.target_not_reached` does not apply in `auto`.

Requirements: a closed manifold stays closed (`measureMesh` watertight); bodies (groups) and segments are kept; a vertex never moves more than 0.35 of its shortest incident edge, never away from the original surface, and never so that a triangle folds; the result is deterministic for one engine. Input with fewer than 4 triangles, an index out of range or a non-finite coordinate gives `lowpoly.bad_input`; inconsistent groups give `lowpoly.groups_unsupported`. A model with no more triangles than the target is returned unchanged with the warning `lowpoly.already_smaller`; `lowpoly.target_not_reached` (held creases or many bodies need more triangles) and `lowpoly.volume_changed` (more than 15 percent) are warnings. The report has `triangles_before`, `triangles_after`, `volume_change_percent` (null for an open mesh), `max_error`, `engine`, `creases`, `moved`, `max_move`.

### 5A.9 Voronoi pattern (plugin `org.ateliermesh.voronoi`, operation `voronoi`)

A Voronoi pattern on the surface: a modifier, `personalisable: 'optional'`, stages `pattern`, `unfold`, `cut`. The pattern is a set of closed outlines on a flat map (origin at the anchor, +x the reading direction turned by `placement.direction`) that go through the same unfold, imprint and lift stages as text (section 5A.1 to 5A.6), so the result is one closed mesh and the cut raises, engraves or recolours it.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `region` | enum `rectangle`, `circle` | rectangle | Shape of the area around the anchor. |
| `width`, `height_area` | float, 1 to 400 mm | 40, 30 | Size of a rectangular area. |
| `radius` | float, 0.5 to 200 mm | 20 | Radius of a circular area. |
| `margin` | float, 0 to 50 mm | 1 | Clearance between the pattern and the edge of the area. |
| `cells` | int, 2 to 2000 | 40 | About how many cells (personalisable). |
| `seed` | int, 0 to 999 999 | 1 | Seed of the generator (personalisable). Same seed, same pattern. |
| `irregularity` | float, 0 to 1 | 0.6 | 0: Lloyd-relaxed, even cells. 1: random seeds. |
| `line_width` | float, 0.1 to 20 mm | 1.2 | Gap between two cells, and the width of the lines. |
| `fill` | bool | false | The cells are the shape (pads) instead of the lines between them. |
| `rounding` | float, 0 to 10 mm | 0 | Corner radius of the cells. |
| `mode`, `height`, `placement`, `segment`, `walls_segment`, `min_stroke`, `min_wall` | as `emboss` | `segment` is `voronoi`, `walls_segment` is `voronoi_walls` | |

Algorithm: seeds from a seeded generator (mulberry32) inside the area; `ceil((1 - irregularity) * 10)` Lloyd steps (each seed moves to the centroid of its cell); the cell of each seed is the area clipped by the bisector with every near seed (a grid of seeds finds them ring by ring and stops when no farther seed can reach the cell); each cell shrinks by half a line width, so neighbours leave a gap of one line width; `rounding` is an offset in and out with round joins; the lines are the area minus the pads (which also keep one line width from the edge of the area), or, with `fill`, the pads. Requirements: deterministic for a seed; the result is a closed manifold; flat mode keeps the geometry and adds no wall segment; a pattern that cannot be printed is an error with a code (`voronoi.cells_too_small`, `.too_many_cells`, `.too_heavy`, `.empty_pattern`, `.does_not_fit`) and a warning (`voronoi.thin_lines`) when the lines are narrower than `min_stroke`.

### 5A.9b Voronoi shell (plugin `org.ateliermesh.voronoi`, operation `voronoi_shell`)

Hollows a closed model into a lattice of struts around irregular openings. A modifier, category `shape`, `personalisable: 'optional'` (`cells` and `seed`), stages `pattern`, `field`, `surface`. The input must be a closed manifold solid (`voronoi_shell.bad_input` otherwise: add Repair mesh first) with no groups (`voronoi_shell.groups_unsupported`). The result is a new closed solid; segments and groups are dropped (`outputs.drops`).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `beam_rounding` | float, 0 to 1 | 0 | Roundness of the struts. 0 uses `smooth` as before; above 0 it replaces `smooth` with k = 0.6 * beam_rounding * min(`thickness`, `rib_width`) in the smooth maximum (a fillet of about half the thinnest side at 1; the strut section loses about 18 % of its area, against 21 % for a perfect rounded rectangle), and the voxel is a quarter of the thinnest feature instead of a third. |
| `thickness` | float, 0.4 to 50 mm | 2 | Depth of the wall, measured inward from the outside. |
| `rib_width` | float, 0.6 to 20 mm | 2 | Width of the struts. |
| `smooth` | float, 0 to 5 mm | 0.6 | Rounding of the joints (polynomial smooth maximum). 0 keeps them sharp. |
| `cells` | int, 2 to 1500 | 60 | About how many openings (personalisable). |
| `seed` | int, 0 to 999 999 | 1 | Seed of the generator (personalisable). Same seed, same lattice. |
| `irregularity` | float, 0 to 1 | 0.5 | 0: Lloyd-relaxed, even openings. 1: Poisson-disk start without relaxation. |
| `opening` | enum `none`, `bottom`, `top`, `both` | none | A round opening along the vertical (Z) axis through the top and/or the bottom, with a collar of one strut width round its edge. |
| `opening_diameter` | float, 1 to 400 mm | 20 | Diameter of the hole. |
| `detail` | enum `auto`, `fine`, `extra_fine`, `coarse` | fine | Voxel size: a third of the thinnest of `thickness` and `rib_width` (clamped to 0.15 to 4 mm), times 0.7 (fine), 1 (auto) or 1.6 (coarse); a preview run uses voxels 1.4 times as big. |
| `max_triangles` | int, 1000 to 5 000 000 | 600 000 | The result is reduced to this many triangles with the decimation engine when it has more. |

Method (an implicit surface, so it works on any closed mesh): (1) the signed distance `d(p)` to the model on a voxel grid, from a bounding-volume hierarchy with a closest-point query, signed by the angle-weighted pseudo-normal of the nearest feature (exact for a closed manifold mesh), evaluated only in blocks of 8 voxels whose centre is within the wall plus half a block diagonal; (2) `shell = max(d, -d - thickness)`; (3) `cells` seeds on the surface (area-weighted cloud, Poisson-disk start, `round((1 - irregularity) * 8)` Lloyd steps on the cloud) and `rib` = the distance to the bisector planes of the ten nearest seeds (a smooth minimum of width `smooth`, so the corners of the openings are rounded), minus half the strut width; (4) `f = smoothmax(shell, rib)`, with the collar and the hole subtracted when there is an opening; (5) marching tetrahedra (six tetrahedra per cube around one diagonal, so neighbouring cubes agree on every face; one vertex per grid edge, so the surface is closed by construction; every triangle turned to face towards increasing `f`), then three rounds of Laplacian smoothing, each followed by a Newton step back onto `f = 0` along the gradient of the trilinear field, then a pull of the vertices within 0.75 voxel of the input back onto it, weighted by how well the vertex normal agrees with the direction to the surface (so strut side walls are not squashed) and only onto flat patches and sharp edges of the input (not onto the 10 to 40 degree facets of a coarse curved surface). The seeded generator is the only source of randomness.

Problems (codes `voronoi_shell.*`): `bad_input` (error, `reason: 'not_closed'`), `groups_unsupported` (error), `cells_too_small` (error, carries `max_cells`), `too_heavy` (error: the grid would exceed 60 million voxels, or marching tetrahedra 12 million triangles; the fix is `detail: 'coarse'`), `empty_result` (error), `thin_ribs` and `thin_wall` (warnings below 0.8 mm), `thickness_too_big` (warning: the model is not deep enough for a cavity of that thickness; carries `depth`). Report: `voxel_mm`, `grid`, `grid_cells`, `band_voxels`, `cells`, `cell_spacing_mm`, `surface_area_mm2`, `triangles_raw`, `triangles`, `decimated`, `max_depth_mm`, `volume_before`, `volume_after`, `closed`, `timing_ms` per stage.

### 5A.10 Deform (plugin `org.ateliermesh.deform`, operations `twist`, `taper` and `smooth`)

Two modifiers, `personalisable: 'optional'`, stage `deform`. Each applies a smooth map of space to the whole mesh: `twist` turns every slice across the axis by `angle * e(t)` about the axis; `taper` scales the cross-section by `1 + (scale_end - 1) * e(t)`. `t` is the position along `axis` (`x`, `y` or `z`, default `z`) as a fraction of the range `[from, to]` (0 to 1 of the model's extent, defaults 0 and 1), clamped to 0..1, and `e` is the easing (`linear` or `smooth`, a smoothstep). Below the range the model stays where it is; above it the model is turned or scaled as a whole, so it never tears. The centre of the turn or scaling in the cross-section is `center` (`bbox_center`, `origin` or `point` with `center_point`).

- **Parameters:** twist: `angle` (degrees, -1440 to 1440, default 90, personalisable). Taper: `scale_end` (0.05 to 5, default 0.5, personalisable) and `uniform` (`both`, `x`, `y`: the first or second of the two axes that are not the axis, in x, y, z order). Both: `easing`, `axis`, `center`, `center_point`, `from`, `to`, `detail` (`auto`, `fine`, `coarse`: tolerance 0.02 mm, a quarter of it, four times it, at most 1 % of the extent) and `max_triangles` (default 1 000 000).
- **Method:** the mesh is cut by parallel planes across the axis, evenly spread over the range (the range ends are always planes). The number follows from the tolerance: for a twist the chord of the arc a point travels between two planes sags by `r * d^2 / 8`; for a taper the straight edge between two images differs from the image by `|du| * |ds| / 4`. A triangle that crosses planes is cut into strips, and the crossing point of an edge is shared by both triangles through an edge table, so the mesh stays closed and conforming. Children follow their parent, so groups keep contiguous ranges and every child keeps its parent's segment label. Flat triangles (the ends of a part) are never cut. The number of triangles grows with the number of planes. Then every vertex is moved with the closed-form map.
- **Closed solid:** both maps are one-to-one and keep the orientation (the Jacobian is 1 for a twist and the product of the scales for a taper), so a closed solid stays closed and cannot cross itself. The volume changes only by the facet error (about 0.6 % for a 180 degree twist of a 10 x 10 x 40 mm pillar) and, for a taper, by the real change of shape.
- **Problems:** `deform.may_fold` (warning: a surface line is stretched more than four times, or the cross-section is squeezed below 20 % of its size; carries `at`, the position along the axis in percent), `deform.too_heavy` (error: the cut would exceed `max_triangles`; carries `triangles` and `limit`), `deform.bad_range` (`from` is not below `to`), `deform.folds` (error: the Jacobian is not positive anywhere; cannot happen with the allowed parameters, kept as a guard), `deform.bad_input` (empty mesh). Cancelled runs return `run.cancelled`.
- **Report:** `triangles_before`, `triangles_after`, `slices`, `tolerance_mm`, `max_displacement_mm`, `volume_change_percent`, `closed`, `min_jacobian`, `max_stretch`.
- **Order:** a twist or taper belongs above text steps (the letters would otherwise be bent with the surface) and below a repair step; Reduce triangles and Low poly belong below it. `orderHints` says so (`deform_after_text`, `reduce_before_deform`).

**`smooth` ('Smooth surface')** evens out the surface of a mesh without shrinking it, and without adding or removing a triangle: only the positions of the vertices change, so groups, segments and the triangle count are untouched and a closed solid stays closed. A modifier, category `shape`, `personalisable: 'optional'` (only `strength`), stage `smooth`.

- **Method:** Taubin lambda|mu smoothing with uniform (umbrella) weights. One iteration is a pass with `lambda` followed by a pass with a negative `mu`, each moving a vertex towards the mean of its neighbours; both read the old positions (Jacobi), so the result does not depend on the vertex order. `mu` follows from `lambda` for a pass band of 0.1 (`1/lambda + 1/mu = 0.1`). With uniform weights the operator's eigenvalues lie in [0, 2] and the pair is stable only up to `lambda` of about 0.63, so a `strength` of 1 is Taubin's pair (0.6307, -0.6732) and smaller strengths scale `lambda` down. With `keep_volume` off only the `lambda` pass runs (plain Laplacian smoothing, which shrinks; `lambda` up to 0.9). Vertices at the same place (split seams) are one vertex.
- **Parameters:** `strength` (0 to 1, default 0.5, personalisable; 0 changes nothing and returns the same mesh), `iterations` (1 to 100, default 10), `keep_edges` (0 to 180 degrees, default 40), `keep_volume` (default on), `keep_borders` (default on), `max_move` (mm, default 0 = no limit), `part` (a segment or a body, empty = the whole mesh) and `falloff` (mm, default 2).
- **Edges:** an edge where the surface turns by more than `keep_edges` degrees (the angle between the two face normals) is a crease. A vertex with exactly two crease edges lies on a crease line and moves along it only (the mean of its two crease neighbours), so a straight edge stays straight and a rough one becomes smooth; a vertex with one, or three or more, crease edges (the end of a line, a corner) does not move. An edge of more than two triangles counts as a crease. 180 smooths everything; 0 makes every edge that is not flat a crease, so almost nothing moves. The default 40 keeps the corners of a box exactly.
- **Open meshes:** the border vertices stay where they are (`keep_borders`), or are smoothed along the border like a crease line.
- **A part:** only the vertices of the part's triangles move; the others keep their bits. With `falloff` above 0 the vertices on the border of the part stay put and the weight grows (smoothstep of the distance along the surface) to 1 at `falloff` mm inside.
- **Limits of the filter:** the pass band lets components with a very low frequency through, with a gain a hair above 1 (a ball drifts outward by about 1 % over 25 iterations at strength 1); thin tubes and strong curvature at the scale of an edge are treated as noise and wear away (a 2 mm strut sampled with 1.3 mm triangles loses about 2 % of the volume of a lattice in preview quality, 0.2 % in export quality); uniform weights also move vertices along the surface on a very uneven triangulation. `max_move` caps how far a vertex may go.
- **Problems:** `smooth.thin_features` (warning: a vertex moved by more than 20 % of the smallest side of the model, or the volume changed by more than 5 %; carries `move` and `change`), `smooth.bad_input` (error: an empty mesh).
- **Report:** `triangles`, `iterations`, `lambda`, `mu`, `max_displacement_mm`, `mean_displacement_mm`, `volume_change_percent`, `closed`, `moved_vertices`, `fixed_vertices`, `crease_edges`, `capped_vertices`, `unchanged`, `timing_ms`.
- **Order:** smoothing evens out what the steps above it made, so it belongs below a Voronoi shell, a texture or a twist or taper (`smooth_before_surface`), and it rounds letters and surface patterns, so it belongs above the text steps and the Voronoi pattern (`smooth_after_text`). Reducing triangles or Low poly after it is fine.


#### Bend, wave and ripple (plugin version 0.3.0)

Three more modifiers of the same plugin (`personalisable: 'optional'`, category `shape`, stage `deform`). A stored 0.2 step still runs.

- **`bend`** bends the model round a circle. Parameters: `angle` (degrees, -360 to 360, default 45, personalisable: the total bend over the range), `axis` (the length direction, default `z`), `bend_axis` (the direction it folds towards, default `x`; it must differ from `axis`, else `deform.bad_axes`), `center`, `center_point`, `from`, `to`, `detail` (`auto`, `fine`, `extra_fine`, `coarse`), `max_triangles`. With span = the range length, `k = angle / span` and arc length `s = clamp(w - w0, 0, span)`, a point at offset `d` from the centre in the fold direction goes to `w' = w0 + s * sinc(k s) - d sin(k s)` and `b' = b0 + s (1 - cos(k s)) / (k s) + d cos(k s)`; beyond the ends the model is carried on rigidly along the tangent. The Jacobian is `1 - k d`. The mesh is cut by planes across the axis (as many as the sag `|R - d| * phi^2 / 8` needs, R = 1/k), so the closed-solid, group and segment rules of twist apply. `deform.may_fold` warns when a surface line is stretched or squeezed more than four times (the inner side is closer than R/4 to the centre of the circle); `deform.folds` refuses a model whose inner side reaches the centre (Jacobian not positive).
- **`wave`** moves every point by `f(u) * direction`, `f(u) = A * fade(u) * sin(2 pi (u - u0) / lambda + phase)`. Parameters: `amplitude` (mm, default 2, personalisable), `wavelength` (mm, default 10, personalisable), `phase` (degrees), `axis` (the direction the wave travels along, default `x`), `direction` (`x`, `y`, `z` or `normal`, default `z`), `falloff` (mm over which the wave fades in and out at the ends of the range), `from`, `to`, `detail`, `max_triangles`. `u0` is the start of the range along `axis`. A displacement along an axis that does not depend on the position along that axis is a shear, so a closed solid stays closed and keeps its volume exactly. A wave along its own axis folds where `A * 2 pi / lambda >= 1` (`deform.folds`); a wave along the surface normal warns with `deform.wave_too_big` when `A` is more than a quarter of the smallest side of the model.
- **`ripple`** moves every point along `axis` (default `z`) by `A * decay(r) * edge(r) * sin(2 pi r / lambda + phase)`, `r` the distance from `center` in the other two coordinates. Parameters: `amplitude` (mm, default 1.5, personalisable), `wavelength` (default 8, personalisable), `decay` (mm: amplitude falls as `exp(-r / decay)`; 0 = none), `radius` (mm: the rings stop there, with a soft edge over the last quarter; 0 = unlimited), `phase` (degrees, default 90: a smooth crest in the middle; 0 starts with a point), `axis`, `center`, `center_point`, `detail`, `max_triangles`. It is a shear along `axis`: the thickness of a plate is kept, the volume is unchanged and the result is closed.
- **Refinement of wave and ripple:** edges are split at their midpoints in rounds (a split edge is split in every triangle that has it, so the mesh stays conforming: a triangle with one, two or three split edges becomes two, three or four). An edge is split when it is longer than 1.5 times `min(sqrt(8 tol / (A k^2)), lambda / 16)` times 0.5 (`fine`), 0.25 (`extra_fine`) or 2 (`coarse`), `k = 2 pi / lambda`, `tol = max(0.02 mm, 0.025 A)` (a chord of a sine that spans `d` sags by `A k^2 d^2 / 8`). For the wave only the extent along the travel axis counts; for the ripple the length in the cross-section counts, and the amplitude is the strongest the edge can meet (edges where the ripple is under a quarter of the tolerance are not split; edges within one wavelength of the centre are half as long). Children follow their parent, so groups keep contiguous ranges and segments carry over. An amplitude of 0 returns the model untouched.
- **Problems:** `deform.may_fold`, `deform.folds`, `deform.too_heavy`, `deform.bad_range`, `deform.bad_input` as above, `deform.bad_axes` (error: the length and the fold direction of a bend are the same axis), `deform.bad_wavelength` (error), `deform.wave_too_big` (warning).
- **Report:** bend as twist; wave and ripple: `triangles_before`, `triangles_after`, `rounds`, `tolerance_mm`, `edge_limit_mm`, `max_displacement_mm`, `volume_change_percent`, `closed`, `min_jacobian`.
- **Order:** like twist and taper (above text, cheese and smooth steps; Reduce triangles and Low poly below). `orderHints` covers every operation of the plugin except `smooth`.

### 5A.10 Repair mesh (plugin `org.ateliermesh.repair`, operation `repair_mesh`)

Makes a damaged mesh a closed, consistently oriented solid. A modifier, `personalisable: 'never'`, stages `weld`, `manifold`, `islands`, `holes`. It belongs first in a step list (`orderHints` code `repair_first`).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `weld` | float, 0 to 10 mm | 0.001 | Vertices closer than this become one. 0 switches welding off. |
| `non_manifold` | enum `split`, `remove`, `off` | `split` | What happens to the triangles left over on an edge shared by more than two. |
| `fix_normals` | bool | true | Consistent winding per shell and shells pointing outward (cavities and negative bodies keep their orientation). |
| `min_island` | float, 0 to 50 % | 1 | Shells smaller than this share of the largest shell go; shells of fewer than four triangles always go. 0 keeps every shell. |
| `max_hole` | int, 0 to 100 000 | 200 | The most boundary edges of a hole that is closed. 0 closes none. |

Order of work: weld, drop degenerate and duplicate triangles, resolve non-manifold edges, orient, drop islands, fill holes. Groups are repaired one at a time and keep their order, role and name (empty groups are dropped); segment labels of kept triangles are kept and a cap takes the most common label around its hole. Requirements: the result is a closed solid whenever every hole is within `max_hole` and its cap does not cross itself; a mesh that needs nothing is returned unchanged (`report.unchanged`); deterministic; stops on cancellation. Not an error: a mesh that is still open comes back with the warning `repair.still_open` (and `repair.hole_too_big`, `repair.hole_skipped` for the reason). Errors: `repair.bad_input`, `repair.groups_unsupported`. Report: counts before and after, `closed`, `volume_before`, `volume_after`, `volume_change_percent`, `did`, and one counter per repair.

### 5A.11 Parts (plugin `org.ateliermesh.parts`, operations `delete_part` and `keep_part`)

Remove a part of the mesh, or keep only one. A part is a segment (a labelled set of triangles of a surface) or a group (a distinct body); the `part` parameter (`kinds: ['group', 'segment']`) names it, with a `group:` or `segment:` prefix when both kinds have that name. Modifiers, category `prepare`, `personalisable: 'never'`, stages `parts` and `holes`. They belong near the start of the list, after a repair step (`orderHints` code `parts_first`).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `part` | part (group or segment) | empty | The part. Empty is an error (`parts.nothing_chosen`). `body` names the whole default surface. |
| `close_hole` | enum `fill`, `none` | `fill` | Removing a SEGMENT leaves an opening in the surface: `fill` closes it with the repair plugin's hole filling (nothing else of it runs; a cap takes the label most triangles around its hole have); `none` leaves it. Removing a whole GROUP closes nothing: the other bodies were closed solids and stay so. |
| `remove_unused` | bool | true | Drop the vertices no triangle uses. (A cap rebuilds the vertex list anyway.) |

- **What stays:** a filter on the triangles, so the order is kept. Groups keep their order, roles and names, with shifted ranges; a group that loses every triangle leaves the list. The segment table keeps every other entry with its id; an entry that lost every triangle leaves it. Groups that do not cover the mesh in order are refused (`parts.groups_unsupported`).
- **Errors:** `parts.nothing_chosen`; `parts.would_remove_everything` (the last body, or every triangle); the shared `part.unknown` and `part.ambiguous`; `parts.bad_input` (no triangles).
- **Warnings:** `parts.result_open` (the input was a closed solid and the result is not: close the opening, or repair it) and `parts.cap_skipped` (a cap would cross itself or was too big).
- **Parts the next steps may name:** `outputs.drops` is `[{ param: "part" }]` for `delete_part` and `[{ param: "part", keep: true }]` for `keep_part`, so a later step that names a removed part gets `part.dropped` before anything runs. For `keep_part`, only parts of the kept part's own kind are known to go (the segments inside a removed body are not judged).
- **Report:** `mode`, `kind`, `part`, `triangles_before`, `triangles_after`, `removed_triangles`, `cap_triangles`, `closed_before`, `closed`, `segments_removed`, `groups_removed`.

## 6. Runtime contract

Plugins run in a Worker (or sandboxed iframe) and export one `run` function that receives the operation id:

```ts
export default {
  async run(op: string, ctx: {
    params: Record<string, unknown>;      // validated, defaults filled
    mesh?: Mesh;                          // from the previous step
    assets(id: string): Promise<Uint8Array>;   // resolved by the host (fonts, textures)
    quality: 'preview' | 'export';
    progress(stage: string, fraction: number): void;
    signal: AbortSignal;                  // cancellation
    log(level: 'info'|'warn'|'error', msg: string): void;
  }): Promise<{ mesh?: Mesh; report?: Record<string, unknown>; warnings?: StructuredError[] }>,
  migrate?(fromVersion: string, params: Record<string, unknown>, op: string): Record<string, unknown>,
}
```
The exact types are in `packages/core/src/types.ts`; `docs/plugin-authoring.md` explains them. (Earlier drafts had `meshes`, `host` helpers and string warnings; they were dropped when the core was built.)
Requirements:
- `run` MUST be a pure function of its inputs (no hidden state between runs). This makes caching valid.
- Plugins MUST check `signal` regularly and stop when it fires.
- A new Worker or fresh state per run is RECOMMENDED. Hosts MAY pool Workers.
- `quality: 'preview'` lets a plugin return a fast approximation. If so it MUST set `report.preview_approximate = true` so the UI can say it differs from export.
- Hosts MUST enforce `limits` (timeout, memory, triangle budget) and kill offending Workers.
- A plugin that crashes (a thrown exception it did not mean, code that cannot be imported, a Worker that dies or answers with something unreadable) is reported as `plugin.crashed` with `{ plugin, name, version, op, step, phase: 'load' | 'run' | 'worker', message }` (`message` is the first line, at most 200 characters), and the engine switches the plugin off (`registry.setEnabled(id, false, message, true)`). Its steps then fail with `plugin.disabled` until a host switches it on again. A plugin's own structured error, a cancellation and a timeout are never crashes. The earlier steps keep their results; later steps wait like after any error. The server rule is unchanged: the host decides, the engine never blocks a plugin by itself on the server.

## 7. Project file (`.amproj`)

A ZIP:
```
project.json        { "format_version":1, "workflow":[ { id, plugin:{id,version}, op, enabled, params, bindings? } ], "rollback": <stepId|null> }
assets/<sha256>.<ext>
inputs/<name>.stl   optional embedded source meshes
plugins.lock.json   exact plugin ids, versions, hashes used
preview.png         optional picture of the result, for lists and cards
```
- Params are stored as plain JSON; asset params store the asset hash.
- `preview.png` is a PNG of at most 1 MB and 1024 x 1024 pixels (the standalone writes 480 x 320, transparent, isometric view). A writer refuses bytes that are not such a PNG (`export.invalid_preview`); a reader leaves out a picture it does not accept and still opens the project. Only the PNG header is read; the bytes are never treated as markup. Files from before this entry, and the old name `thumbnail.png`, still open.
- On open, the host checks `plugins.lock.json`. Missing plugins are offered for install, and version differences produce a warning.
- Each plugin MAY provide a `migrate(oldVersion, params)` function so old projects load when a plugin changes its params.
- Import limit: hosts SHOULD cap uncompressed size (BumpMesh uses 500 MB).

## 8. Security and trust

Default: a plugin has **no** access to network, filesystem, DOM, or storage. It receives data only through `run` and can read only its own package assets.

`permissions` (declared, shown to the user at install, enforced by the host):
- `network:<origin>` fetch from a named origin
- `storage` persistent per-plugin storage
- `clipboard`
- `webgpu`

Signing: `manifest.sha256` (hash of every file) + `manifest.sig` (Ed25519 or RSA, by the author key). Signatures prove authorship and integrity only. They grant no extra permissions. Host UI shows signed/unsigned and the permission list. Hosts MUST verify hashes on install and on load of packaged plugins. Unpacked dev plugins skip checks and are labelled as such.

## 9. Agent access (MCP mapping)

The manifest doubles as tool schemas:
- Each operation maps to an MCP tool. The tool input schema is derived from `params` (JSON Schema).
- Extra host tools: `workflow.get`, `workflow.add_step`, `workflow.edit_step`, `workflow.remove_step`, `workflow.run`, `workflow.export`.
- This lets an agent build and edit the same editable workflow a person uses.

## 10. Host UI requirements (minimum)
1. Step list with add/insert/reorder/suppress/delete/duplicate and a rollback marker.
2. Auto-generated parameter panel from the manifest, with sections, conditional visibility, units and per-type controls.
3. Live preview using `quality: 'preview'`, with an "approximate" indicator when set.
4. Progress per stage and cancel.
5. Presets (save/load/apply).
6. Per-step status: ok, stale, running, error, with the message shown at the step.
7. Undo/redo of workflow edits.
8. Export via exporter steps or a final export button.

## 10A. Recipes

A recipe is an export of the steps you have, without the model: the same step list, saved so it can be added to another model later. It is plain JSON (UTF-8, extension `.amrecipe`) and has no UI or storage of its own, so a host keeps it in a file, in the browser, or in its own database (the Atelier: a designer's template).

```json
{ "format": "ateliermesh-recipe", "version": 1, "name": "My name", "created": "2026-11-09T10:00:00.000Z",
  "steps": { "schema_version": 1, "steps": [ ... ] },
  "plugins": [ { "id": "org.ateliermesh.core", "version": "0.2.0" } ],
  "assets": [ { "id": "logo", "name": "logo.svg", "mime": "image/svg+xml", "base64": "..." } ] }
```

- **Order.** The steps are the current list in its own order; they run top to bottom. `applyRecipe(target, recipe)` appends them after the target's steps, in the recipe's order, with new ids (`s<n>`, continuing after the highest in the target). Names, parameters, personalisable flags and limits are kept; part references are kept as written (`checkPartReferences` warns when the new model has no such part). A step that needs a place on the model (a text with `placement: null`) stays valid-but-unplaced; the editor selects it and starts the click-to-place mode.
- **Plugins.** `plugins` is worked out from the steps (a reader ignores what the file claims). `recipeProblems(recipe, registry)` lists plugins that are missing, plugins in another version, and operations the installed plugin does not have; `applyRecipe(..., { skipMissing: true, registry })` leaves those steps out and says which.
- **Assets.** Only when a step refers to an SVG or an image the host keeps; at most 2 MB decoded in total; types `image/svg+xml`, `image/png`, `image/jpeg`. Fonts are never embedded (a step names a font by its id).
- **Limits.** 1 MB of text without the assets, 100 steps, a name of at most 120 characters. `parseRecipe` never throws; it returns structured errors `recipe.not_json`, `recipe.not_a_recipe`, `recipe.version_newer`, `recipe.too_large`, `recipe.field`, `recipe.too_many_steps`, `recipe.steps_invalid`, `recipe.unsafe_key` (`__proto__`, `constructor`, `prototype` anywhere), `recipe.bad_asset`, `recipe.assets_too_large`.
- **Deterministic.** `serializeRecipe` sorts the keys, so the same recipe gives the same text.

## 11. Versioning and conformance
- `manifest_version` and `host.api` are independent integers/semvers. The host MUST enforce them.
- Operation kinds and param types are the extension points. A host that meets an unknown param type MUST refuse the plugin (not silently ignore it).
- A **conformance suite** (planned) contains sample plugins plus expected outputs, so multiple hosts can verify they behave the same.

## 12. Open questions
1. Linear pipeline only, or a DAG (for example two generators joined by a boolean)? Proposed: linear in v1, with mesh-typed params providing limited branching.
2. Topology-dependent masks: is fingerprint-and-warn enough, or should hosts offer geometric re-projection of masks?
3. Expression language for `visible_if`: pick an existing safe subset (for example JSONLogic) or define a minimal one?
4. Sketch-based steps (2D profile then extrude): need a `sketch` param type and a 2D data model. Propose a v1.1 addition.
5. WASM plugins (for example CAD kernels like OpenCascade or Manifold): allowed via the same Worker contract, but need clear memory limits.
6. How to treat AGPL tools such as BumpMesh: either re-implement under a permissive licence, or wrap via file formats/process boundary. Needs a legal decision.
7. Whether to emit the 3MF displacement extension instead of baking displaced geometry, so slicers can apply textures themselves.

## 13. Prior art
- BumpMesh (github.com/CNCKitchen/stlTexturizer, AGPL-3.0): parameter richness, preview/export split, `.bumpmesh` ZIP project format.
- A slicer's Lua plugin preview (experimental, 2026): manifest + declarative params + sandbox + signing. Gaps this spec addresses: more param types, enforced versions, permissions, workflow chaining, scene reading.
- OpenSCAD customizer annotations, JSCAD `getParameterDefinitions`: parameter schemas.
- 3MF (ISO/IEC 25422:2025) and its displacement extension: output format.
- MCP: agent tool exposure.

### Asset hints (added)
An `asset` parameter may carry `widget: "font" | "gallery"` and `preview: "text"`. `widget` suggests a grid (fonts, pictures); `preview: "text"` says each choice is best shown with the user's own text. They are hints: a host that does not know them shows a plain picker, and the manifest never lists the assets themselves (the host owns the `library`). AtelierMesh 0.2.2: the font grid is drawn only for `widget: "font"` (or `accept: ["font"]`); a `gallery` of pictures shows the host's own Choose… button, which asks for a picture (PNG, JPEG or WebP, checked by its first bytes) and keeps the file as `image:<name>`; the picture gallery with the plugin's own library, thumbnails and upload is not built yet.

### Parameters and operation fields for heavier plugins (added)
Written so a surface-texture plugin (an image displaces the surface, with projections, masks and layers) can be described without further changes to the engine. None of these needs a plugin to exist first; `packages/core/test/texture-like.test.ts` checks a manifest of that shape and a fake plugin.

| Addition | Meaning |
|---|---|
| `range` | `[low, high]`, low at most high, both within `min` and `max` (a band of angles). The panel shows two number fields. |
| `selection` | Which triangles: `{ mode: "include" \| "exclude", triangles: [[start, count], ...], basis? }`. Runs ascend and do not overlap. `basis` is the `meshKey` of the mesh it was made on, so a host can warn when the mesh changed. `null` is none. The host provides the way to mark triangles (`onSelectionRequest`). JSON Schema cannot say "ascending", so the server check of that one rule is the TypeScript validator. |
| `list` | Rows of the same fields (`item`), with `min_items` and `max_items`. A row may hold any parameter except another list or a placement. The panel draws each row as a small panel with Add and Remove. |
| `color` | A colour string `#rrggbb` (`#rrggbbaa` with `alpha: true`). `palette` lists swatches a host offers; with `only_palette` the value must be one of them (a shop's filament colours). Stored lower case. The panel shows a picker, a hex field and the swatches. |
| `object` | Several fields held together as one value (an object): `fields` is a list of single-valued parameters (no list, object or placement inside). Shown as a titled box. A nested problem names its field with a dotted path (`edge.w`). |
| `part` | One part of the mesh at this step, chosen by name: a **segment** (a labelled set of triangles of a surface, section 5.1) or a **group** (a distinct body). `kinds` limits the choice (`["segment"]`, `["group"]`, default both); empty means the whole mesh unless `allow_empty: false`. A name that is both a segment and a group is ambiguous: the value then carries a prefix, `segment:lid` or `group:lid` (the panel writes it for you). A group without a name is `part_1`, `part_2`, ... by position. Checked when the step runs (`segment.unknown`, `group.unknown`, `part.unknown`, `part.ambiguous`); `selectPart(mesh, value, kinds)` gives the triangles. Replaces the earlier `segment` type. Not to be confused with the manifest's `groups` (collapsible panel sections). |
| `asset` keys | `allow_upload`, `categories` (strings) and `searchable` (boolean) join `accept`, `library`, `widget` and `preview`. |
| operation `limits` | `max_input_triangles`, `max_output_triangles`, `max_memory_mb` (positions and indices, MiB). The runner refuses a mesh over them, going in or coming out (`budget.triangles` or `budget.memory`, with `of: "input"` or `"result"` and `op`). The host's general budget still applies. |
| operation `outputs.segments`, `outputs.groups`, `outputs.drops` | Which parts a step makes and which it throws away. `segments` and `groups` list names, or `{ "param": "name" }` when a parameter's value names the part (the emboss step: `{ param: "segment" }`). `drops: ["segments"]` or `["groups"]` says the step does not carry them through; `drops: [{ "param": "part" }]` says it removes the one part its `part` parameter names, and `{ "param": "part", "keep": true }` every other part of that kind (the Parts plugin); everything else is kept. `checkPartReferences(list, registry, base?)` then says, without running anything, whether a step that names a part (a `part` parameter) can find it: `part.not_produced` (no file or earlier step makes it, judged only when the host passes the file's own parts as `base`) or `part.dropped` (made earlier, thrown away since). |
| operation `outputs.closed` | The plugin promises a closed result. When the mesh it received was closed and the result is not, the step fails with `plugin.bad_mesh` (`problem: "not_closed"`). An open input is not blamed on the plugin. |

**The cache key includes the content of the assets a step uses.** A texture or font replaced under the same id gives a fresh result, never a stale cached one. The runner hashes the bytes the asset resolver returns, once per run; a host that already knows a content hash passes `assetKey(id)` and the bytes are not read for the key.

**Pictures in a plugin.** `decodeImage(bytes)` (core) turns a PNG or JPEG into RGBA pixels, using `createImageBitmap` and `OffscreenCanvas`. What the pixels mean (a height map, a mask) is the plugin's business. It refuses garbage (`image.invalid`), pictures over a pixel limit (`image.too_large`), and environments without a decoder (`image.unsupported`). Decoding inside the sandboxed worker of an external plugin works in Chromium and WebKit (tested).

**Not changed on purpose:** the mesh still goes to a worker as a copy (copy then transfer, the same peak memory as a structured clone). A shared-memory route needs cross-origin isolation and is left for when a plugin needs it.

### 5A.12 Surface texture (plugin `org.ateliermesh.texture`, operation `texture`)

Moves the surface along its normal by a height pattern (a bump texture): knurls, ridges, hexagons, leather, a picture. A clean implementation from first principles; no code or pictures of other tools are used.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `pattern` | enum | `knurl` | `knurl`, `ridges`, `waves`, `dots`, `hex_dots`, `hexagons`, `bricks`, `weave`, `grid`, `noise`, `leather`, `wood`, `stipple`, `image`. Every built-in pattern is a pure function h(u, v) in [0, 1] that repeats with period 1 in u and v, so tiles never show a seam. |
| `amplitude` | float mm | 0.6 | How far the surface moves; negative cuts in. 0 leaves the mesh untouched. Personalisable. |
| `scale` | float mm | 5 | The size of one tile. Personalisable. |
| `offset` | 0..1 | 0 | The zero level: 0 raises from the surface, 1 cuts into it, 0.5 does both. |
| `seed`, `roughness`, `octaves`, `fill` | | | Pattern options (shown for the patterns that use them): the random seed (personalisable), the strength of fine detail, the layers of a noise, the share of a cell the raised feature takes. |
| `image`, `tiling`, `invert` | asset, enum, bool | | A PNG or JPEG as the height map (light is high), repeated or placed once. |
| `mapping` | enum | `triplanar` | `triplanar` (blend by normal, `blend` 1..16), `planar` (axis), `cylindrical` and `spherical` (about `axis`, a whole number of tiles round so there is no seam; the caps of a cylinder are planar), `box` (the dominant axis only). Also `rotation`, `offset_u`, `offset_v`. |
| `region`, `edge_falloff` | part, mm | all, 1 | Texture only a segment or group. The texture fades to zero over `edge_falloff` mm from a sharp edge (dihedral angle over 30 degrees), from the border of the region and from an open edge, so edges stay crisp. The fade is a straight ramp: `smooth(distance / edge_falloff)` with the straight distance to the edge segments. 0 runs the pattern right up to the edge. |
| `segment` | segment name | empty | Give the textured triangles this segment (for multicolour printing). |
| `detail`, `smooth_normals`, `max_triangles` | | `auto`, true, 1 000 000 | How finely the surface is cut (see below), smoothed move directions, and the limit. |

- **Method:** (1) the triangles of the region are split per edge (1 to 2, 3 or 4 triangles, midpoints shared by the two sides of an edge, so a closed mesh stays closed) until no edge is longer than L, a quarter of the pattern's smallest feature (never below 0.15 mm; `fine` halves it, `coarse` doubles it); children follow their parent, so groups keep contiguous ranges and segment labels carry over. (2) Every vertex gets a smoothed normal and a weight from a shortest-path distance to the nearest crease, region border or open edge. (3) The pattern is read at the vertex through the mapping. (4) p' = p + n * amplitude * (h - offset) * weight.
- **Cut near edges and where the pattern changes (0.1.1):** for the patterns that are flat over much of the surface (`dots`, `hex_dots`, `stipple`) the cut is fine (the target length L) only where the pattern changes along an edge or a sharp edge / region border is near, and up to four times coarser elsewhere, with a red-green closure so the pieces stay round; this gives a cheese block about 40 % of the triangles of a uniform cut. For every pattern the cut goes down to half the fade length near a sharp edge, so the fade ramp is followed also with a large tile.
- **Triangle quality (0.1.1):** after the cut, inside the flat patches (every triangle of a vertex star in one plane, one segment, one body, all in the region) edges are flipped by the Delaunay rule and the vertices relaxed in their plane, a few small steps with undo of any step that turns a triangle. The shape, the groups and the segment labels do not change. It is skipped when under 1 % of the triangles have an angle under 30 degrees. On a plate of 12 triangles the share of triangles with a smallest angle under 20 degrees falls from 19 % to about 1 %; on a cylinder from 93 % to 9 %.
- **Pictures:** a PNG (8 or 16 bit grey, grey with alpha, RGB, RGBA, palette; not interlaced) is read by a small decoder in the plugin, which gives the same numbers in a browser, a worker and Node. Other formats (JPEG) go through `createImageBitmap` and `OffscreenCanvas` where the platform has them; otherwise `texture.image_unsupported`. At most 8192 pixels on a side; above 2048 it is averaged down.
- **Problems:** `texture.too_heavy` (error, with the count, the limit and the edge length; the button sets `detail` to `coarse`), `texture.may_self_intersect` (warning: triangles turned over, or a displacement above half the local radius of curvature), `texture.no_image`, `texture.image_unsupported`, `texture.image_too_large`, `texture.bad_input`.
- **Report:** pattern, amplitude, scale, triangles before and after, textured triangles, edge length, largest displacement, volume change in percent, closed solid, turned triangles. Stages: `subdivide` and `displace`.
- **Order:** a texture belongs above text steps (`texture_before_text`), and reducing triangles after a texture smooths it away (`reduce_after_texture`).
- **Measured** (desktop, Node): a 50 x 50 x 4 mm plate with a knurl on the top at 0.5 mm edges: 66 000 triangles in 0.3 s; a 25 mm sphere with hexagons: 328 000 triangles in 0.8 to 1.3 s; a 40 x 30 x 20 mm block with hexagons on every face: 213 000 triangles in 0.8 s.

### 5A.13 Hollow (plugin `org.ateliermesh.hollow`, operation `hollow`)

Hollows a closed model to a wall of `thickness` mm. Without an opening the outside of the model is **not touched**: every vertex, triangle, segment and body of the input stays as it was (letters, textures and all), and an inner surface is added. With an opening the outside has to be cut, so the whole result is made again from a distance field.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `thickness` | float mm | 2 (0.4 to 50) | The wall, measured inward from the outside. Main parameter. |
| `smooth` | float mm | 0.6 | How much the inside is smoothed (rounds of smoothing after the grid: three at the default); with an opening also the rounding of the rim. 0 keeps what the grid gives. |
| `opening`, `opening_diameter` | enum, float mm | `none`, 5 | A round opening along Z through the top, the bottom or both halves (split at the middle of the bounding box). Generic: to drain, vent or fit something in. |
| `detail` | enum | `auto` | The voxel is a third of the wall (`fine` x 0.7, `coarse` x 1.6); a preview run uses voxels twice as big; with an opening the grid is 0.7 times as fine again because the outside is made from it. |
| `max_triangles` | int | 600 000 | With an opening: more triangles than this are reduced (keeping the border of the opening). Without an opening the outside is never reduced, so the limit does not apply. |
| `cavity_segment` | segment name | `cavity` | The part given to the inside triangles; empty gives them none. Note that a 3MF export gives every part other than `body` its own colour and extruder number, so empty this for a one-material print if the slicer should not see the inside as a second part. |

- **Method A (no opening):** (1) the signed distance `d` to the model (negative inside) on a voxel grid, measured in blocks of 8 voxels, split into blocks of 4 and only then voxel by voxel, and only where the surface `d = -thickness` can be (the distance changes by no more than the distance moved, so the far blocks get one constant); (2) marching tetrahedra on `f = -d - thickness`, so the triangles face into the void; (3) a few rounds of smoothing that put every vertex back on `f = 0`; (4) closed pieces a few voxels wide (noise at the thin places) are dropped; (5) the cavity is appended to the input. With bodies each body's cavity is put right after that body's triangles so every body stays one range (name, role and order kept); the body of a cavity piece is the body of the outer triangle nearest to it. The input's segments keep their labels.
- **Method B (opening):** the hollow is made as in A, then a round cutter along Z is subtracted exactly (the hole plugin's cut) from the top and/or the bottom, down into the void: the outside keeps every vertex and sharp edge, and the rim of the hole is sharp (`smooth` then only rounds the inside). Only when that fails (no void under the axis, a cut that is not closed) the old way is used: `wall = max(d, -d - thickness)`, the cylinder is subtracted with a polynomial smooth maximum (`smooth`), the surface is extracted and smoothed as above. The outside is a new mesh of about the same shape (the report says `outer_remeshed` and the step warns `hollow.outer_remeshed`, an information). Segments and groups are not kept, except that the inside gets `cavity_segment`. Only one body can be hollowed with an opening.
- **Closed solid in, closed solid out** (`outputs.closed`). A model that is not closed is refused (`hollow.bad_input`: add Repair mesh first).
- **Bodies:** every body is hollowed (method A). Refused with `hollow.groups_unsupported`: groups that do not cover the whole mesh (a single group that does not cover it is simply treated as no groups), a `negative` body, and several bodies with an opening. A model with exactly one group is hollowed like any other. Bodies must not overlap.
- **Problems:** `hollow.thin_walls` (warning, wall under 0.8 mm; button sets the wall to 0.8), `hollow.thickness_too_big` (warning: the model is thinner than the wall everywhere, so it comes back as it was; button suggests a thinner wall), `hollow.outer_remeshed` (information), `hollow.too_heavy` (error: grid over 60 million voxels or more than 12 million triangles; button sets `detail` to `coarse`), `hollow.bad_input`, `hollow.groups_unsupported`.
- **Report:** `hollowed`, `outer_remeshed`, voxel size, grid, voxels measured, triangles before and after, cavity triangles, volume before and after, cavity volume, the wall measured at up to 1500 points (`wall_min_mm`, `wall_mean_mm`), the deepest point, bubbles dropped, time per stage. Stages `field`, `surface`, `cavity`.
- **Order:** hollow belongs below the steps that make the outside (text, texture, Voronoi pattern): `hollow_last`; and above a Voronoi shell, which would be made from the whole solid: `hollow_before_shell`.
- **Measured** (desktop, Node): a 25 mm ball (20 000 to 82 000 triangles in) with a 2 mm wall: preview 0.3 to 0.6 s, export 0.9 to 1.5 s; 328 000 triangles in: preview 1.7 s, export 3.8 s. Wall measured 2.000 mm thinnest and 2.003 mm on average; volume within 0.2 % of the analytic shell. With an opening: 3 to 9 s at export detail (a new outside of about 600 000 triangles).

### 5A.14 Cheese (plugin `be.micro-fabriek.cheese`, operation `cheese`; a package of its own since 0.3.6, formerly the built-in `org.ateliermesh.cheese`; its source is kept in the plugin factory since 0.3.7)

Round holes of different sizes in a closed solid, like Swiss cheese. Holes overlap and merge freely, as in a real cheese: what is removed is the union of the spheres, so merged holes share one opening (or one chamber) whose wall is made of several sphere patches that meet in clean creases. A hole is a round pit with a curved bottom that opens through the outside, or an inner hole (a chamber or tunnel) that overlaps another hole; a void that touches nothing is never made. The result is one closed manifold solid. Category `shape`; `holes` and `seed` can be handed to the customer.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `part` | part (segment or group) | empty | Make holes only through this part of the surface (for example the top face). Empty: the whole surface. Only holes that cross the selected triangles are kept, and a hole that would reach a triangle that is not selected is dropped. |
| `holes` | int 1..2000 | 40 | How many holes to try to place. Fewer are made when they do not fit (warning `cheese.too_many_holes` with the number placed; when a `part` is chosen the warning is `cheese.selection_too_small`: the selected surface is too small or too thin for the radius range, with the buttons "Make N holes" and "Make the largest hole N mm"). |
| `overlap` | float 0..1 | 0.3 | How often holes overlap their neighbours. 0 keeps them apart (a wall of `min_wall` between them), 1 makes many overlaps and clusters. |
| `seed` | int | 1 | Decides the whole arrangement; the same number gives the same result on every machine. |
| `min_radius`, `max_radius` | float mm | 0, 0 | The smallest and the largest hole. 0 chooses for the model (about 6 % and 15 % of the thinnest side). A largest hole above 45 % of the thinnest side is brought down (warning `cheese.holes_too_big`). |
| `min_wall` | float mm | 0.8 | The thinnest wall left between a hole and the other faces of the part, and between two holes that do not overlap. Below 0.8 mm the step warns (`cheese.thin_walls`). |
| `smooth` | float mm | 0.3 | Rounds the rims of the holes. 0 leaves them sharp. |
| `detail` | enum | `auto` | `auto`, `fine`, `extra_fine`, `coarse`: how finely the surface is cut around the holes (a preview is cut 1.5 times coarser). |

**Method.** Holes are placed with a seeded generator, largest first, radii drawn from a skewed distribution (many small, few large). Holes may cross edges and corners of the model: the cut and the filling of the sphere region work from the actual loops, which may run across several faces. A candidate starts on the selected surface (chosen by area) with its middle a little below it, or next to an earlier hole close enough to overlap it (chosen with probability `overlap`). A hole is kept when its sphere crosses at least one selected triangle or overlaps a kept hole, and no hole may reach a triangle that is not selected (with a margin for the subdivision around it); with `part` set it may still cross edges between selected faces. `min_wall` guards real thin parts: the solid must still reach `min_wall` beyond the bottom of the hole along its axis, and no wall between the hole and a face may be thinner than that. Overlaps must be clean (the overlap depth is at least a quarter of the smaller radius and neither middle lies inside the other hole). An inner hole is only made when it overlaps another hole. The reasons for holes that were not placed are counted (outside the selection, would breach another surface, did not fit).

The outside is not made again. Holes are cut in rounds: a round is a set of holes that do not touch, and a hole that overlaps an earlier one comes in a later round, where the earlier pit is just more surface. A round is an exact subtraction of spheres from a closed triangle mesh: the triangles near the spheres are split at edge midpoints (the surface does not move); every vertex inside a sphere is removed with its triangles; edges that cross a sphere get a new vertex exactly on the sphere; the loops of new vertices are closed by the part of the sphere that is inside the solid and outside every other hole, triangulated by a constrained Delaunay triangulation after a stereographic (or, when the region fits a hemisphere, orthographic) projection with the loops as constraints. Every original triangle that no hole is near stays bit for bit (text, texture, colour parts, sharp edges). Where holes merge only the triangles around that cluster are cut; nothing is remeshed. A surface that is not closed after the rounds is made again one hole at a time and the hole that breaks it is left out (counted as dropped). Rim rounding (Taubin smoothing, width `smooth`) moves only vertices within `smooth` of a rim.

**Several bodies.** A mesh with several bodies (groups) is supported: `part` = a body name cuts holes in that body only (every other body keeps its triangles bit for bit, group names, roles and order stay valid, the cut body keeps its place); `part` empty gives every body holes, with `holes` as the total split by the area of the surface that may be used (largest remainder, ties to the first body; each body has its own seed offset, so the result is deterministic); a segment `part` works across bodies. Bodies are independent: a hole never crosses from one body into another, and bodies that overlap each other are not supported. Each body must be a closed solid.

Errors: `cheese.bad_input` (not a closed solid: add Repair mesh first; or the selected part has no triangles), `cheese.groups_unsupported` (the bodies do not cover the mesh in order, or one is a negative volume; `reason`: `not_covering` or `negative`), `cheese.too_heavy` (more than 1.5 million triangles: use coarser detail or fewer holes). Report: `holes_requested`, `holes_placed` (kept), `part`, `unplaced_outside_selection`, `unplaced_would_breach`, `unplaced_did_not_fit`, `merged` (holes that overlap another), `clusters` (separate cavities), `dropped`, `rounds`, radii, triangles before and after, `kept_share`, volume before and after, `closed`, timings. Measured (Node, block 40 x 30 x 20 mm, 60 holes): preview 1.1 s, export 3.7 s; ball of 25 mm radius: 4 to 5 s; every result closed, volume equal to the union of the spheres within 6 % (Monte Carlo test).

Exact surface (0.1.2): the original surface is never moved. A vertex near a sphere stays and the cut goes through it; `smooth` rounds with an exact smooth-maximum field of width 1.5 x `smooth`, moving only vertices within that width of both the surface and a sphere (onto the rounded surface, then relaxed along it); every other vertex is exactly on the input surface (tested to 1e-6 mm, measured 1e-9). Calm rims (0.1.1): a surface vertex within 10 % of the longest edge of a sphere is moved onto it before the cut (a vertex on an earlier wall slides along it to the crease circle), so the cut makes no sliver; a hole that cannot be closed is cut again with a smaller move, in the end none. On the sample (90 holes, preview / export) the worst triangle is 0.039 / 0.023 (was 0.003 / 0.002) and there is no zero-area triangle. A cut by convex polytopes was tried and was worse.

Order hints: `cheese_last` (text, a texture, a pattern or a twist after a cheese step) and `cheese_before_smooth` (a Smooth surface step above it).

### 5A.15 Print check (plugin `org.ateliermesh.printcheck`, operation `printability`)

An analyzer (category `check`): it reports what could go wrong when the model is printed and never changes the mesh. The report is machine readable so a host can show it any way it likes; the standalone shows a card (`PrintReport` in `@ateliermesh/react`).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `process` | enum `fdm` \| `resin` | `fdm` | The kind of printer. It sets the automatic limits below. |
| `nozzle` | float 0.1..1.5 mm | 0.4 | FDM only. |
| `layer_height` | float 0.02..0.6 mm | 0.2 | FDM only. A detail thinner than four layers does not come out in height. |
| `bed` | vector x, y, z in mm | 220, 220, 250 | The build volume; 0 on an axis leaves it out; 0, 0, 0 leaves the check out. |
| `min_wall`, `min_feature`, `min_gap` | float mm | 0 | 0 = automatic. FDM: wall 2 x nozzle, feature the larger of 2 x nozzle and 4 x layer height, gap 1 x nozzle. Resin: 0.6, 0.3, 0.2 mm. |
| `overhang_angle` | float 1..89 deg | 45 | Faces that lean over more than this need support (the shared overhang measure, 5A.3). |
| `bridge_length` | float 1..100 mm | 10 | The longest flat roof that prints without support (also the unsupported width the `overhang` and `bridge` findings allow). |
| `min_overhang_area` | float 0..10000 mm2 | 20 | A sloped overhang region smaller than this is left out of the advice to add support. Added later (optional; a step stored without it runs with the default; the plugin stays at 0.1.0). |

**The checks.** Every check gives one finding `{ code, name, severity, count, value, unit, share, at?, triangles?, params }`; `severity` is `ok`, `info`, `warning` or `error`, `share` is the part of the surface (by area) that fails, `triangles` are runs `[start, length]` of the flagged triangles for the 3D view, `at` is where the worst case is.
- `not_closed`: the surface is one closed, consistently wound solid (open edges, edges shared by three or more triangles, inconsistently wound edges, an inside-out volume). Error when any of them is found.
- `islands`: separate shells. Warning when a shell is tiny (under 1 % of the biggest one's triangles or under 5 % of its size), otherwise a note.
- `thin_walls`: from sample points on the surface a ray goes straight in along the inward normal; the distance to the first surface is the wall thickness. Below `min_wall` is thin. Warning when 0.3 % of the surface or three samples are thin, an error when 1 % or more is thinner than 0.9 x the nozzle (resin: 0.45 x the wall limit).
- `thin_features`: a thin sample is a post, pin or spike, not a wall, when looking along the surface from the middle of the wall it is thinner than `min_feature` both ways (a wall is long in at least one of them).
- `narrow_gaps`: the ray goes out along the normal; a surface that faces back (within about 37 degrees of parallel) closer than `min_gap` is a gap that will fuse.
- `needs_support`: the overhang area and its share of the surface (warning from 5 %, a note from 0.5 %); `long_bridges`: flat roofs (within 20 degrees of horizontal, not on the bed) joined over shared edges; the span is the shorter side of the roof's bounding box; warning above `bridge_length`.
- **Printing in mid-air** (`printcheck-air.ts`; the model is printed from its lowest point up, Z up; "the plate" is the lowest z; one tolerance of 0.05 mm for "on the plate" and the narrowest gap, at least 0.05 mm, for "touching", because a narrower gap fuses). All of it is O(triangles) plus a bounded number of rays, with no random numbers.
  - `floating_body` (error: will not print as it is): a separate shell whose lowest point is above the plate and that rests on nothing. A shell rests on another when a ray straight down from one of its 12 lowest vertices meets the top of that shell within the contact distance, or starts inside it (overlap); the chain must end on a shell that touches the plate. `value` is the height of the lowest floating body; `params`: `bodies`, `gap`, `size`. The advice: connect it to the model or print it separately.
  - `island` (error: will not print as it is): one connected piece of the model that starts in mid-air, found as a local minimum of the surface above the plate: vertices joined by edges that are level (within max(0.005 mm, 2e-5 x diagonal)) form a plateau, and a plateau whose every neighbour is higher, above the plate, with nothing carrying it (same ray test), is the start of a new island. Its first layer is the projected area of the lower surface within one layer height of the minimum. A first layer under 0.25 mm2 is ignored (a needle point; the overhang check speaks for it), 0.25 to 1 mm2 is a *tip* (warning), 1 mm2 or more is an error. `params`: `count`, `tips`, `height` (above the plate), `area` (first layer), `size`; the 3D view lights the triangles around the start. A bridge between two feet, a cantilever or a shelf that is joined to a wall that goes down is not an island: the printer has something to print on (that is an `overhang` or a `bridge`).
  - `overhang` (warning: will need supports or a different orientation): the faces that lean over more than `overhang_angle` (measured from straight down; faces on the plate, and flat faces that rest on another shell, are left out) joined over shared edges into regions. A nearly flat region (80 % of its area within 20 degrees of horizontal) is judged by its unsupported width, the diameter of the widest disc that fits in it (a distance map on a grid of at most 160 x 160 cells): it needs support above `bridge_length`. Any other region needs support when it is larger than `min_overhang_area`. `value` is the total area of the regions that need support; `params`: `regions`, `area`, `percent`, `largest` (mm2), `height` (of the largest above the plate), `angle`, `min_area`. A flat roof anchored on both sides is reported as `bridge` instead: a wall goes down from at least 45 % of its boundary (a deck over a gap), whereas a cantilever (a T, a mushroom) is held on one side only.
  - `bridge` (warning): flat roofs anchored on both sides wider than `bridge_length` (`value` the widest, `params`: `count`, `widest`, `max`, `height`, `area`).
  - **Turn advice.** When one of these three is a problem the six axis orientations are scored by the shared overhang measure (the Orient step's own, 5A.3); when the best is not the current one and cuts the overhang area to 70 % or less, the findings carry `turn: 1`, `from_area`, `to_area` and `turn_x`, `turn_y`, `turn_z` (the `rotate` angles, degrees, order XYZ) and use the texts `mesh.printcheck.<name>_turn` ("Turn the model so the flat side is down ... the overhang drops from 1200 mm2 to 80 mm2"). Otherwise `turn: 0` and the text says to add supports in the slicer or turn the model. It is geometry only: whether supports are really needed depends on the printer, the material and the slicer.
  - The older `needs_support` and `long_bridges` findings stay (same names, values and prices); the report card hides them when the newer `overhang` or `bridge` finding already says the same.
- `tiny_base`: less than 2 mm2 (or 0.2 % of the surface) rests flat on the bed. `too_tall`: height over the wider footprint side above 6 is a warning, above 15 an error; a centre of mass higher than four times the base radius (on a model over 20 mm tall) is a warning too.
- `too_big_for_bed`: the size as it lies against `bed`; when it does not fit, the model is turned about Z in steps of 5 degrees: a fit is a warning (`turn` gives the angle), no fit is an error.
- `needles` (triangles with an angle under 5 degrees) and `detail` (the triangle count) are notes.

**Sampling.** 4 000 area-weighted points in a preview and 16 000 in an export (fewer on a model with very few triangles), from a fixed seed: the same model gives the same report. Flagged triangles are the sampled ones, so on a model with far more triangles than samples the highlight is sparse while `share` stays right. A million triangles take about 3 s.

**Score and verdict.** The score starts at 100 and loses a fixed price per finding: `not_closed` 40; `too_big_for_bed` 40 (error) or 10 (warning); `islands` 10; `thin_walls` 25 (error) or 8 plus up to 10 by share; `thin_features` 15 or 8; `narrow_gaps` 8; `needs_support` 3 plus 25 x share, at most 10; `long_bridges` 5; `floating_body` 30; `island` 20 (error) or 3 (tip); `overhang` 4; `bridge` 3; `tiny_base` 8; `too_tall` 15 or 8. Notes cost nothing. Verdict: `not_printable` when any finding is an error; `fix_recommended` when any is a warning or the score is under 90; else `good`.

Report: `{ verdict, score, issues, findings, thresholds, samples, size, triangles, ms }`. Every finding that is a warning or an error is also returned as a structured warning of the step, `printcheck.<name>` (an analyzer never blocks). The mesh comes back as it was.

### 5A.15 Cut hole (plugin `org.ateliermesh.holes`, operation `cut_hole`)

One hole (round, slot or square), or a pocket, cut into a closed solid at the place the user clicks. It is the general form of the openings of Hollow and the holes of Cheese: keyring holes, drain and vent holes, screw holes and pockets. Kind `modifier`, category `shape`; `placement` and `diameter` may be personalisable.

**Method (exact, measured).** The hole is a convex prism or cone with planar faces, and its outline is a regular polygon (48 to 192 sides; chord error at most 0.01 mm export, 0.02 mm preview; the radius is pushed out so the polygon has exactly the area of the circle). The cut is an exact boolean subtract done locally: only the triangles the cutter touches are rebuilt (cut along the planes of the cutter, triangulated without new points inside the region), and the wall of the hole is built from the same shared vertices, so the result is closed by construction. All other triangles keep their vertices and their order bit for bit, and segments and selections carry over. A countersink or counterbore is a second cut. If a result is not watertight (the hole lies exactly on a mesh edge, say), the cutter is moved by a fixed micro-nudge (0.14 µm up to 0.3 mm, five fixed steps) and cut again; this is deterministic. After five attempts the step stops with `holes.not_robust`. There is no re-mesh fallback (`holes.remeshed_locally` is not used): none was needed. In a stress test of 120 random places, shapes, sizes and depths on a grid box, a sphere and a 96-sided cylinder, every result was one closed solid; a through hole in a box removes the volume of the polygon prism exactly.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `placement` | placement | none | Where the hole starts, its direction (turn) and the surface normal. Required. |
| `shape` | `round`, `slot`, `square` | `round` | |
| `diameter` | float mm 0.5..100 | 4 | Round: diameter. Slot and square: width. |
| `length` | float mm | 10 | Slot and square: length. |
| `corner_radius` | float mm | 0 | Rounding of the square. |
| `depth` | float mm | 0 | 0 cuts through. More: a blind hole from the surface. |
| `countersink` | `none`, `countersink`, `counterbore` | `none` | A wider opening for a screw head (cone of 90°, or cylinder). |
| `countersink_diameter`, `countersink_depth` | float mm | 0, 0 | 0 chooses a suitable value. |
| `rotation` | degrees | 0 | Turns a slot or a square about its axis. |
| `axis` | `normal`, `x`, `y`, `z` | `normal` | Direction of the hole: straight into the surface, or along an axis into the model. |
| `min_wall` | float mm | 0.8 | The thinnest wall that may stay under a blind hole (warning below it). |
| `part` | selection | empty | Cut only through this part of the surface; a hole that would breach another part is `holes.breaches`. |

Report: `volume_before`, `volume_after`, `volume_removed`, `triangles_before`, `triangles`, `cut_triangles`, `through`, `wall_under_bottom`, `attempts`, and `timing_ms` for the stages `hole_cut` and `hole_wall`. Progress and cancellation are supported; the result is deterministic.

Errors: `holes.no_placement`, `holes.bad_input` (not a closed solid), `holes.groups_unsupported` (more than one body), `holes.misses_model`, `holes.breaches`, `holes.too_big` (nothing would be left), `holes.too_heavy` (more than 400 000 triangles touched), `holes.not_robust`. Warning: `holes.thin_wall` (the fix sets a shallower depth).

Order hints: `holes_last` (text, a texture, a pattern, cheese holes or a twist after a hole step) and `holes_before_smooth` (a Smooth surface step above it).

Limits: no rim rounding (`smooth`) yet, no array of holes, one hole per step, and a model with several bodies is refused.
