# Running AtelierMesh headless

## The command: a recipe on a model

```
ateliermesh recipe.amrecipe model.stl result.3mf
```

A recipe (`.amrecipe`) is the list of steps you saved in the app (Recipes, Save to file). The command applies those steps, in order, to an STL or 3MF file and writes an STL or 3MF file. No browser, no server. The built-in plugins are included.

Build it once, from the repository root (Node 24 or newer, `npm install` done):

```
npm run build:cli          # writes build/cli/ateliermesh.mjs, one file you can copy anywhere Node runs
node build/cli/ateliermesh.mjs recipe.amrecipe model.stl result.3mf
```

(`npm run pack` and `npm run bundle:atelier` wipe `build/`: build the command last, or copy the file out.)

| Option | Meaning |
|---|---|
| `--fonts <folder>` | Fonts for text steps. A folder with a `fonts.json` like the app's `fonts/` folder, or plain font files named like the font (`Quicksand.ttf` for `font:Quicksand`). |
| `--font <id>=<file>` | One font file for the asset id a step uses, for example `--font font:Quicksand=Quicksand-Bold.ttf`. Can be repeated. |
| `--quality preview\|export` | Default `export`, full detail. |
| `--json` | Also print `{ output, triangles, size, watertight, seconds }` as one JSON line on stdout. |
| `--quiet` | Print only problems. |

- Roboto is built in (`roboto-regular`, `font:Roboto`). Other fonts a recipe uses must be given with `--font` or `--fonts`; a missing one is reported by name. Pictures and SVGs a step uses are read from the recipe itself. Variable WOFF2 fonts are not read directly: use the TrueType files from the deployed app's `fonts/atelier/` folder.
- Only the built-in plugins are included. A recipe that needs another plugin stops with its name before anything runs.
- Exit code 0: written. 1: a step failed or a file could not be used (nothing is written; the failing step and its code are printed). 2: wrong command line.
- A text or other placed step uses the position stored in the recipe; on a different model it can fail the same way it does in the app (for example `emboss.touches_patch_edge`).

## Using the engine from your own script

The engine (`packages/core`) and the built-in plugins (`packages/plugins`) have no DOM, no React and no three.js. They run in plain Node, for scripts, batch jobs, tests and servers. The packages are not on npm, so you run them from a checkout of this repository.

## Requirements
- Node 24 or newer, `npm install` done in the repository root.
- Scripts are TypeScript and run with `vite-node` (already a dev dependency), which resolves `@ateliermesh/*` to the sources.

## The shape of a run
1. Read a mesh: `parseStl(bytes).mesh` (STL) or `await read3mf(bytes)` (3MF).
2. Make a `Registry` and register the plugins you need (`corePlugin()`, `hollowPlugin()`, ...; all are exported by `packages/plugins/src`).
3. Build a step list: `emptyStepList()`, `makeStep({ id, plugin: { id, version }, op, params })`, `addStep(list, step)`.
4. `await runWorkflow(steps, { registry, source })` returns `{ ok, mesh, results }`. `results` has one entry per step with `report`, `warnings` and `error` (a `MeshError` code and params).
5. Write the result: `writeStlBinary(mesh)` or `write3mf(mesh, { slicer: 'none', title })`, and check it with `measureMesh(mesh)` (triangles, volume, size, `watertight`).

Parameters are the same as in the app: each op's parameters are in its plugin manifest (`op.params`) and in `docs/plugin-guide.md`. Parameters you leave out take their manifest default. An error is not thrown: look at `r.ok` and `r.results[i].error`.

## Example
`scripts/headless-example.ts` reduces the triangles of an STL file:

```
npx vite-node scripts/headless-example.ts model.stl reduced.stl 0.05
```

It prints `{ before, after, watertight }`. On the Benchy sample (40,000 triangles) a tolerance of 0.05 mm gives about 14,000 triangles, still closed.

The core of it:

```ts
import { Registry, addStep, emptyStepList, makeStep, parseStl, runWorkflow, writeStlBinary } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin } from './packages/plugins/src'

const source = parseStl(new Uint8Array(fs.readFileSync('model.stl'))).mesh
const registry = new Registry().register(corePlugin())
const steps = addStep(emptyStepList(), makeStep({
  id: 'reduce', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION },
  op: 'decimate', params: { mode: 'quality', tolerance: 0.05 },
}))
const r = await runWorkflow(steps, { registry, source })
if (!r.ok || !r.mesh) throw new Error(JSON.stringify(r.results.find(x => x.error)?.error))
fs.writeFileSync('reduced.stl', writeStlBinary(r.mesh))
```

Several steps work the same way: add them in order; each step works on the result of the one above it. More runnable examples: `scripts/make-*-sample.ts` (they build the sample files of the app).

## Notes
- Long runs: pass `signal` (an `AbortSignal`) in the options of `runWorkflow` to cancel; the remaining steps get the status `cancelled`.
- Steps that place text need a font, which the app supplies from its own files; see `docs/fonts.md` before using them headless (not tried here).
- Third-party `.amplugin` packages are loaded by `packages/loader`; this page covers only the built-in plugins.
- Heavy steps (Voronoi shell, Hollow, Cheese) can take tens of seconds on large meshes; there is no worker in Node, the run is on the calling thread.
- The licence is AGPL-3.0-or-later (see `LICENSING.md`): a service that offers this engine over a network has to offer its source.
