# Payload kinds: meshes, drawings and what comes next

Status: built in the core (0.2.3). Nothing changes for an existing plugin or host: a step still takes a mesh and returns a mesh unless it says otherwise.

## The idea

A workflow is a list of steps. Each step takes **something** and returns **something**. Until now that something was always a mesh. It can now also be a **drawing** (flat vector paths), so one workflow can start from a 2D shape and end in a 3D model:

```
Drawing  ──shift──▶  Drawing  ──extrude──▶  Mesh  ──hollow──▶  Mesh
 (2D)                                        (3D)
```

The engine keeps the order of the steps, the cache, the history and the project file. It does not know what a mesh or a drawing is; each **kind** says how to recognise itself, fingerprint itself, count its memory, check itself when it comes from outside, and save and load itself.

## What an operation declares

```jsonc
{ "id": "extrude", "kind": "modifier", "payload": { "in": "drawing", "out": "mesh" }, ... }
```

| Field | Meaning | Default |
|---|---|---|
| `payload.in` | the kind the step takes | `mesh` |
| `payload.out` | the kind the step returns | the same as `in` |

A generator has no input, so only `out` counts (`{ "out": "drawing" }` for a step that draws a square). An analyzer returns a report and keeps what it received.

## What the runner checks

| Situation | Result |
|---|---|
| A step gets another kind than it takes | `input.wrong_kind` (`op`, `expected`, `got`); the later steps are stale |
| A step needs input and there is none | `input.missing_mesh` for a mesh step, `input.missing_payload` (`op`, `kind`) for another kind |
| A step returns another kind than it declared | `plugin.bad_output` (`expected`, `got`) |
| A kind nobody registered | `payload.unknown_kind` |
| A result from an untrusted plugin, or any non-mesh result | shape-checked by the kind (`plugin.bad_mesh` with the problem) |

A host can use `operationPayload(op)` to show in the "Add a step" menu only the operations that take what the last step produced.

## What a plugin sees

```ts
run(op, ctx) {
  const drawing = ctx.payload as Drawing      // whatever the previous step produced
  // ctx.mesh is the same object when it is a mesh, and absent otherwise
  return { payload: { kind: 'drawing', paths: [...] } }   // a mesh may be returned as { mesh } as before
}
```

Non-mesh payloads are copied into the worker (structured clone) and back. They must be plain data. Meshes are still transferred without copying.

## The drawing

`Drawing` is `{ kind: 'drawing', paths, segments?, fillRule? }`. A path is `{ points: [x, y][], closed, segment? }` in millimetres, y up, curves already flattened. `segments` names groups of paths (a host gives a segment its meaning: a colour, an operation). `fillRule` is `nonzero` (default, as in SVG) or `evenodd`. Helpers: `drawingBounds`, `drawingShapeProblem`, `encodeDrawing`, `decodeDrawing`.

## Projects

A project whose base is a drawing stores it as `inputs/base.amdraw` and writes `"base_kind": "drawing"` in `project.json`. A mesh project is written exactly as before (no `base_kind`). `loadProject` accepts only meshes unless the host says which kinds it takes:

```ts
const p = await loadProject<Payload>(bytes, { baseKinds: ['mesh', 'drawing'] })
```

so an editor that only knows meshes is never handed a drawing.

## The project store: a second payload next to the main one

A step takes one main payload (the previous step's). When it needs another one, for example a mesh step that also needs a drawing, the **project store** holds it: named payloads of any registered kind, saved in the project. Full design and the reasons: `docs/proposals/project-store-plan.md`.

```jsonc
// project.json
"store": { "logo": { "kind": "drawing", "file": "store/logo.amdraw", "personalisable": true, "limits": { "maxPaths": 200, "maxPoints": 20000 } } }
```

**The SVG is the single source of truth.** A drawing that came from a file keeps that file: `StoreEntry.source` is `{ kind: 'svg', text, mode: 'fill' | 'line', importer }`. The drawing (`payload`) is extracted from it when it is imported and checked then (`importSvg` in `@ateliermesh/plugins`: bad files throw the code the dialog explains, an import that left things out returns `warnings`), and it is **never edited on its own**: editing or replacing a drawing means changing its SVG, and the drawing follows. The project file writes the SVG as `store/<name>.svg` next to the drawing and the importer version in `project.json`. When a project opens and a drawing was made by another importer version (`SVG_IMPORTER_VERSION`), `refreshSvgDrawings(store)` extracts it again from the SVG, which wins; an SVG that can no longer be imported keeps its drawing and is reported. `useOpenFile` does this for you. A host that calls `loadProject` itself calls `refreshSvgDrawings` on `project.store`. A stored model, or a drawing made by a step, has no source and is its own.

**Taking an entry: the `payload` parameter.** `{ "name": "shape", "type": "payload", "accept": ["drawing"], "default": null }`. The value is the entry's name or `null`. The runner finds it, checks the kind (`input.wrong_kind`, `input.missing_payload` with `name`), checks its shape and budget, adds its content to the step's cache key, and gives the plugin `ctx.payloads.shape` (read only, empty object when the step has no `payload` parameters). Editing the entry re-runs that step and the ones after it, not the ones before.

**Finding it.** A name resolves to the nearest earlier `store` step that wrote it, else to the project's own (imported) entry. Looking backwards only; a disabled `store` step writes nothing.

**The two operations** (plugin `org.ateliermesh.store`; the runner runs them itself, no plugin code). A host registers them with `registerStore(registry)`, in the page and in the worker.

| Operation | Does |
|---|---|
| `store` (`name`) | saves a copy of what it received under `name`, passes it on unchanged. Any kind (`payload: { in: '*', out: '*' }`). A `store` step may not use the name of an imported entry (`store.name_taken`). |
| `load` (`name`) | ignores what it received and returns the entry. No transform: moving or scaling is a step after it. |

**In code.**

```ts
const r = await runWorkflow(list, { registry, source: mesh, store: { logo: { payload: drawing, personalisable: true } } })
saveProject({ name, base: mesh, list, rollback: null, assets: [], store })
const p = await loadProject(bytes, { baseKinds: ['mesh'], storeKinds: ['mesh', 'drawing'] })   // storeKinds defaults to baseKinds
const rows = listStore(p.store, p.list, { registry, results: r.results })   // name, kind, origin, size, usedBy, missing
```

Limits: `limits.maxStoreBytes` and `limits.maxStoreEntries` (in `runWorkflow` and `loadProject`), and an entry's own `limits` (tighter paths and points for what a customer may add). Errors: `store.bad_name`, `store.bad_entry`, `store.name_taken`, `budget.store_bytes`, `budget.store_entries`.

Used by: `emboss_svg` (`org.ateliermesh.core` 0.4.0) takes a stored drawing as its `shape`; import an SVG with `svgToDrawing` from `@ateliermesh/plugins`. A `payload` setting also works for sandboxed external plugins (`ctx.payloads`).

Not built yet: the editors, the stored-items panel, and the apps' picker for a `payload` setting (slice 4 of the plan).

## Adding a kind

```ts
payloadKinds.register({ id: 'curves', is, key, bytes, problem, budget, extension: 'amcurves', encode, decode })
```

Register it in the page and in the worker before running a workflow. The id is `^[a-z][a-z0-9_]*$`.

## What is not in the core

- A 2D editor (canvas, selecting and moving paths).
- Built-in drawing plugins (SVG import, offset, text outlines, extrude). They come next as a plugin package; the core only carries the kind.
- Anything about cutting, engraving, materials or prices. A host reads those from segments or its own data.
