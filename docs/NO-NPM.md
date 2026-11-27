# No npm? Three ways to build, test and pack a plugin

You can write an AtelierMesh plugin with **no npm, no network, no TypeScript and no build step**. A plugin is two plain files: `manifest.json` (what it is and what its settings are) and `main.js` (one JavaScript file, no imports). What you can *run* depends on what is installed. Pick the first tier that fits.

| Tier | You have | Write | Test with | Pack with |
|---|---|---|---|---|
| **A** | Node 20 or newer (no npm needed) | `main.js` + `manifest.json` (+ `fixtures.json`) | `node tools/amplugin.mjs check <folder>` and `... run <folder> ...` | `node tools/amplugin.mjs pack <folder>` |
| **B** | Python 3, no Node | the same files | `python3 tools/amplugin_check.py <folder>` (static checks only) | `python3 tools/amplugin_pack.py <folder>` |
| **C** | only a shell (or just an editor) | the same files | by reading: [`CONTRACT-CHEATSHEET.md`](CONTRACT-CHEATSHEET.md) and the checklist below | `sha256sum` + `zip` by hand (recipe below) |

> The npm package named `amplugin` is **not ours**. Do not install it. Our tools are the files in this kit's `tools/` folder. Nothing of AtelierMesh is published on npm.

All paths below are relative to the kit folder. The starting point is [`examples/plugins/mirror-plain`](../examples/plugins/mirror-plain/main.js): a complete plugin in one file.

## The rules for a plain JavaScript plugin (all tiers)

1. `main.js` is **one ES module**: `export default { async run(op, ctx) { ... } }`. **No imports** and no `require`: put every helper in the same file.
2. **Never change `ctx.mesh`.** Build new arrays (`new Float64Array(...)`) and return `{ mesh, report }`.
3. Millimetres, Z up, triangles counter-clockwise seen from outside (a mirror image turns them inside out: swap two corners).
4. **Deterministic**: no `Math.random`, no `Date`, no `performance.now`, no network, no `eval`, no state kept between runs. Need randomness? Take a `seed` setting and write a small generator.
5. **Stop when cancelled**: in a long loop look at `ctx.signal.aborted` every few thousand steps and `throw { code: 'run.cancelled', params: {} }`.
6. **An expected problem is a plain object, not an `Error`**: `throw { code: 'myplugin.too_thin', params: { thickness: 0.2, min: 0.4 } }`. The code starts with your plugin's prefix; the numbers go in `params`. (An `Error` counts as a crash: the host switches the plugin off.)
7. **Keep the labels**: `mesh.segments` (colour parts) and `mesh.groups` (bodies) must come out valid. Triangles that stay the same triangles keep their labels; copy `mesh.segments` / `mesh.groups` to the result. Declare in the manifest (`outputs.drops`) what you remove.
8. A result must be a **closed solid** if the input was one (when the manifest says `"closed": true` the engine checks it).
9. No materials, no prices, no filaments: AtelierMesh does not know them.

## Tier A: Node, no npm

```
node tools/amplugin.mjs new my-plugin                      # writes my-plugin/: manifest.json, main.js, fixtures.json, README.md, locales/
node tools/amplugin.mjs check my-plugin                    # the complete test (see below); exit code 0 = all passed, 1 = something failed
node tools/amplugin.mjs run my-plugin --input generator:box:10,20,30 --params '{"x":5}' --out result.stl
node tools/amplugin.mjs pack my-plugin --out my-plugin.amplugin
node tools/amplugin.mjs inspect my-plugin.amplugin
```

Or copy `examples/plugins/mirror-plain` and change the id in `manifest.json`.

**What `check` does** (it prints `ok`, `FAIL` or `note` per line and a summary):

| Check | Fails when |
|---|---|
| manifest | a missing `license` or `description` is reported in plain words ("manifest.json has no \"license\". Add one, for example ..."); otherwise the real validator finds a problem: it prints the code and the path, for example `manifest.invalid ... params.depth.max` |
| source rules | `main.js` uses `Math.random`, the clock, `fetch`, `eval`, `import` or storage: it names the line and why |
| loading | `main.js` is not a valid module with a default export that has `run` |
| settings | the defaults are not valid, or `personalisable` is `"never"` but a setting is marked personalisable |
| a default run | the operation fails on a 10 x 20 x 30 box with its default settings |
| determinism | two runs on the same input give a different mesh |
| closed in, closed out | the manifest says `"closed": true` but a box, a sphere or an L bracket comes out open |
| labels | segments or groups of a labelled box disappear or become invalid (unless declared in `outputs.drops`) |
| cancelling | a run with an already cancelled signal throws something that is not `run.cancelled` |
| `fixtures.json` | any fixture's expectation is not met |

**`fixtures.json`** is a list. Each fixture names an operation, its settings, an input and what must be true:

```json
[
  { "name": "a 10 x 20 x 30 box keeps its size",
    "operation": "shift", "params": { "x": 5 },
    "input": { "generator": "box", "params": { "width": 10, "depth": 20, "height": 30 } },
    "expect": { "triangles": 12, "volume": { "value": 6000, "tol": 1e-6 }, "size": { "value": [10, 20, 30], "tol": 1e-9 }, "watertight": true } },
  { "name": "a setting above its limit is refused",
    "operation": "shift", "params": { "x": 5000 }, "input": { "generator": "box" },
    "expect": { "ok": false, "error_code": "param.out_of_range" } }
]
```

Inputs: `{ "generator": "box" | "sphere" | "cylinder" | "l_bracket", "params": {...} }` (box: `width`, `depth`, `height`; sphere: `radius`, `subdivisions`; cylinder: `radius`, `height`, `segments`) or `{ "positions": [...], "indices": [...] }`. Expectations (all optional, with tolerances): `ok`, `error_code`, `triangles` (a number or `{ "min", "max" }`), `vertices`, `volume`, `surface_area`, `size`, `bbox`, `watertight`, `step_reports`. Use several steps with `"steps": [{ "operation": ..., "params": ... }]`.

**`run`** takes `--input` as a `.stl` or `.3mf` file, or `generator:box`, `generator:box:10,20,30`, `generator:plate`, `generator:sphere:5`, `generator:cylinder:5,10`, `generator:l_bracket`. `--op` picks the operation (the first one by default), `--params` is JSON. `--out` writes `.stl` or `.3mf`.

**Drawings and stored items.** For an operation that takes a flat drawing, `--input drawing:square` (a 20 x 10 mm rectangle; `drawing:square:40,20` for another size) or a drawing file (`.amdraw`). For a setting of type `payload` (a stored drawing or model), `--payload <setting>=<drawing:square | file.amdraw | model.stl | generator:box>`, once for each such setting. `--out` writes `.amdraw` when the result is a drawing. `check` gives such an operation a small sample drawing (or box) of the kind it accepts. In `fixtures.json` an `input` may be a drawing (`{"kind":"drawing","paths":[...]}`), `store` holds stored items by name, and `expect.payload` checks a drawing result (`kind`, `paths`, `points`, `bounds`). Example: `examples/plugins/shape-fit-plain`.

## Tier B: Python 3, no Node

```
python3 tools/amplugin_check.py my-plugin                    # static checks of the folder
python3 tools/amplugin_pack.py my-plugin --out my-plugin.amplugin
python3 tools/amplugin_check.py my-plugin.amplugin           # checks the package: entries and manifest.sha256
```

What the Python tools do: the manifest's shape (ids, types, enum defaults, min and max, sections), the same source rules as `check`, `fixtures.json` (well formed, operations and settings exist), `locales/` (valid JSON, the same keys in en, nl and fr, the package limits and the rule that keys stay in the plugin's own namespace), and for a package the entries and `manifest.sha256`. The packer writes **the same package** as the Node tool (same files, same `manifest.sha256`; the ZIP is stored without compression).

What they **cannot** do: *run* your plugin (that needs JavaScript). So determinism, cancelling, closed solids and fixture results are **not tested**. Say so in your report, and ask the person who receives the package to run, where Node exists, `node tools/amplugin.mjs check my-plugin` once. They are also **unsigned**: signing needs `node tools/amplugin.mjs sign`.

## Tier C: only a shell and an editor

Write the files by hand (copy `examples/plugins/mirror-plain` and read [`CONTRACT-CHEATSHEET.md`](CONTRACT-CHEATSHEET.md)), then pack by hand. A package is a ZIP with these entries and nothing else needed:

| Entry | What it is |
|---|---|
| `manifest.json` | the manifest, exactly the bytes you hashed |
| `main.js` | the plugin |
| `assets/...` | optional extra files |
| `manifest.sha256` | optional but recommended: one line per file, `<64 hex sha256>` + **two spaces** + `<path>`, sorted by path in plain byte order (`LC_ALL=C`), the file itself and `manifest.sig` not listed, a newline after every line |

```
cd my-plugin
# 1. the listing (macOS: use `shasum -a 256` instead of sha256sum)
sha256sum manifest.json main.js $(find assets -type f 2>/dev/null) | LC_ALL=C sort -k2 > manifest.sha256
# 2. the zip: -X no extra file attributes, -D no folder entries, paths relative to the plugin folder
zip -X -D ../com.example.my_plugin-0.1.0.amplugin manifest.json main.js manifest.sha256 $(find assets -type f 2>/dev/null)
# 3. the fingerprint to hand over
sha256sum ../com.example.my_plugin-0.1.0.amplugin
```

Rules: entry names are relative with forward slashes (no leading `/`, no `..`, no `\`), the package is at most 20 MB, and `manifest.json` must be valid JSON. If you change any file, redo step 1 and step 2: a listing that does not match the files makes the host refuse the package.

With no tool at all, check your plugin **by reading** with this list, and say that you did:

- [ ] `manifest.json`: `manifest_version` 1; an `id` like `com.example.name`; a `name`; a `version` like `1.0.0`; a `license` (`MIT`, `Apache-2.0`, `GPL-3.0-only` or `Proprietary`) and a `description` (10 to 300 characters of plain text); optionally `contact` (`url` https, `email`, `name`) and `package_url` (https); each operation has `id`, `kind`, `params`; every setting has a `name`, a `type` and a valid `default` (inside `min` and `max`; an enum's default is one of its options). Optionally `image` (`{ "file": "assets/example.png", "alt": "..." }`): the file is in the package, a PNG, JPEG or WebP of at most 300 KB, 200 to 1600 px wide and at most 1200 px high; `alt` is 5 to 160 characters.
- [ ] `main.js`: one file, `export default { async run(op, ctx) {...} }`, no `import`, no `Math.random`, no `Date`, no `fetch`.
- [ ] `run` throws `{ code, params }` objects for expected problems, never an `Error`, and never returns without a mesh from a `modifier`.
- [ ] Nothing writes into `ctx.mesh.positions` or `ctx.mesh.indices`.
- [ ] A long loop looks at `ctx.signal.aborted`.
- [ ] Triangles are not turned inside out by accident (a mirror needs two corners swapped).
- [ ] `segments` and `groups` are carried through.
- [ ] `locales/en.json`, `nl.json` and `fr.json` have the same keys, all inside your plugin's namespace (`ops.<op>.…`, `step.op.<op>`, `mesh.<op>.…`).

**What to hand to the person you work for** (and say plainly what you did *not* run): the `.amplugin` file and its `sha256`; the plugin folder; the list of checks you ran with their output pasted; the list of checks you could not run; and the commands that complete the job where Node exists:

```
node tools/amplugin.mjs check my-plugin
node tools/amplugin.mjs inspect com.example.my_plugin-0.1.0.amplugin
```

Then load the package in the app: **Add a step**, **Plugins…**, **Choose a plugin file**.
