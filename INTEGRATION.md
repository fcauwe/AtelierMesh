# Integrating AtelierMesh into a web app (the Atelier)

Status: 2026-11-09, version 0.2.4. Nothing is published to npm. This file is the short route from "I have the tarballs" to "a customer can put their name on a model".

## 1. What you get

| Package | What it is | Needs |
|---|---|---|
| `@ateliermesh/core` | The engine with no UI and no DOM: step list, validation (designer and customer roles), runner, cache, worker host, STL and 3MF in and out, segments, `applyPermanently`, project file, save package, placement limits | nothing |
| `@ateliermesh/plugins` | `org.ateliermesh.core` 0.4.0: `resize`, `rotate`, `overhang`, `auto_orient`, `emboss` (text on the surface) and `emboss_svg` (a stored drawing on the surface; import an SVG with `svgToDrawing`, keep it in the project store); both raised, engraved or flat, with the surface and the side walls as two segments (`text`, `text_walls`) and their conformance fixtures | `@ateliermesh/core`, fontkit, clipper-lib, cdt2d, svgpath |
| `@ateliermesh/plugins` (second plugin) | `org.ateliermesh.lowpoly` 0.2.0: `low_poly`, an artistic low-poly version of the model (see below). Register it next to the core plugin: `new Registry().register(corePlugin()).register(lowpolyPlugin())`, in the worker too | same package |
| `@ateliermesh/plugins` (third plugin) | `org.ateliermesh.voronoi` 0.2.0: `voronoi`, an artistic Voronoi pattern raised, engraved or flat on the surface, and `voronoi_shell`, a closed model hollowed into a Voronoi lattice (see below). Register it the same way: `.register(voronoiPlugin())`, in the worker too | same package |
| `@ateliermesh/plugins` (fourth plugin) | `org.ateliermesh.repair` 0.1.0: `repair_mesh`, which turns a damaged mesh into a closed solid (see below). Register it the same way: `.register(repairPlugin())`, in the worker too; put its step first in the list | same package |
| `@ateliermesh/plugins` (fifth plugin) | `org.ateliermesh.deform` 0.3.0: `twist`, `taper`, `bend`, `wave` and `ripple`, smooth changes of shape, and `smooth`, which evens out a surface (see below). Register it the same way: `.register(deformPlugin())`. |
| `@ateliermesh/plugins` (texture) | `org.ateliermesh.texture` 0.1.1: `texture`, a surface texture (bump pattern or picture) for printing: 13 built-in patterns, triplanar, planar, cylindrical, spherical and box mapping, a region and an edge fade (see below). Register it with `texturePlugin()`. | `@ateliermesh/core` |
| `@ateliermesh/plugins` (hollow) | `org.ateliermesh.hollow` 0.1.0: `hollow`, which hollows a closed model to a wall thickness; the outside is left exactly as it is, and with an opening it is made again (SPEC 5A.13). Register it next to the core plugin. | `@ateliermesh/core` |
| Cheese holes (not built in: a package of its own; its source is kept in the plugin factory, outside this repository) | `be.micro-fabriek.cheese` 1.0.0 (it was `org.ateliermesh.cheese`, built in until 0.3.5): `cheese`, round holes of random sizes in a closed solid, like Swiss cheese: some hidden inside, some open to the outside as round pits with a curved bottom; the outside keeps its triangles except around the open holes (see below). Registered by `registerBuiltInPlugins`. | `@ateliermesh/core` |
| `@ateliermesh/plugins` (holes) | `org.ateliermesh.holes` 0.1.0: `cut_hole`, one round, slot or square hole or pocket at a clicked place, through or blind, with countersink or counterbore; an exact local boolean, so the rest of the surface stays as it is. |
| `@ateliermesh/plugins` (print check) | `org.ateliermesh.printcheck` 0.1.0: `printability`, an analyzer that reports what could go wrong when the model is printed (closed solid, floating pieces, thin walls and posts, narrow gaps, overhang and long bridges, tiny base, too tall, too big for the bed) with a verdict and a score; it never changes the mesh. The report card is `PrintReport` in `@ateliermesh/react` (see below) |
| `@ateliermesh/ui` | The 3D viewer (loaded on demand), problem texts and part colours | `@ateliermesh/core`, `three` as a peer |

## 2. Install

```
npm run pack                    # in this repository: builds build/tarballs/*.tgz
npm install ./ateliermesh-core-0.2.4.tgz ./ateliermesh-plugins-0.2.4.tgz ./ateliermesh-ui-0.2.4.tgz three@0.186.1
```

Use the exact version. `npm run check:packages` installs the tarballs into a clean project and checks that they import, the fixtures pass, TypeScript accepts the types, there is one copy of three.js and no machine path is built in.

## 2b. For the Atelier: the bundle

`npm run bundle:atelier` assembles everything the Atelier needs in `build/atelier/` (tarballs with `SHA256SUMS`, `INSTALL.md`, example TSX for the upload page, editor page, customer overlay and the three quote files, the texts as nested JSON, the font manifest and TrueType copies, docs, samples, `VERSION.json`) and a zip of it. `npm run check:atelier` proves it in a scratch Vite + React 18 project (typecheck, build, one three.js, Chromium and WebKit smoke test). `registerBuiltInPlugins(registry, { except })` from `@ateliermesh/plugins` registers every first-party plugin with one call; use the same call in the page and in the worker. See `docs/proposals/atelier-handoff.md`.

## 3. The smallest useful setup (what the Atelier adopts first)

```ts
import { Registry, runWorkflow, emptyStepList, addStep, makeStep, followEarlierSteps, validateParams } from '@ateliermesh/core'
import { corePlugin, CORE_PLUGIN_ID, CORE_PLUGIN_VERSION } from '@ateliermesh/plugins'

const registry = new Registry().register(corePlugin())
const list = addStep(emptyStepList(), makeStep({ id: 'r', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'resize', params: { percent: 150 } }))
const result = await runWorkflow(list, { registry, source: mesh, prepareStep: followEarlierSteps(), limits: { maxTriangles: 2_000_000 } })
```

- `mesh` is `{ positions: Float64Array, indices: Uint32Array }` in millimetres, Z up. Read an STL with `parseStl`, a 3MF with `read3mf`.
- Store `serializeStepList(list)` in the Atelier's `operations_json`; read it back with `parseStepList`.
- Run plugin code in a worker: create the worker in your own code (the packages never create one, because the Vite dev server breaks that) and pass `new WorkerHost(() => fromWebWorker(new Worker(url)))` as `host`. See `apps/standalone/src/worker.ts` for the 5-line entry.
- The settings form is part of `@ateliermesh/react` (`StepForm`, drawn from the manifest). The viewer: `const { createViewer } = await loadViewer(); createViewer(THREE, container)`; pass your own `three`.

## 4. The server checks the same rules

The customer's step list arrives at the server as JSON. Check it with the same code (Node 24 or any runtime that runs ES2022):

```ts
const parsed = parseStepList(json)                              // the shape
const check = registry.validateStep(step, { role: 'customer', base: designerStep })   // plugin, version, values, what may be changed
```

- `validateParams(op, params, { role: 'customer', base, personalisableParams })` refuses a change to anything the designer did not hand over, and enforces the designer's placement limits (`placement.too_far`, `placement.direction_out_of_range`, `placement.size_out_of_range`, `placement.limits_changed`).
- Every operation's rules also export as JSON Schema (`operationParamsSchema`), for a server in another language. Conditions (`visible_if`) and the customer role are not expressible there.
- The server measures the final mesh again and prices from its own numbers. `measure.json` in the package is informational.
- Errors are `{ code, params, path }`, never only a sentence. `ERROR_CODES` lists the engine's; plugins add their own with a prefix (`emboss.touches_patch_edge`, `emboss.wall_too_thin`, ...). Translate by code.

A runnable version, with eight cases (accepted and refused, and why), is `examples/server-check.mjs`; `npm run check:packages` runs it against the installed tarballs.

## 5. Files the customer's browser produces

`buildPackage({ source, final, steps, render, palette, stl: true })` gives one ZIP: `source.stl` (untouched), `final.3mf`, `final.stl` while your server cannot read 3MF, `render.png`, `operations.json`, `measure.json`. `saveProject`/`loadProject` is the editor's own file (`.amproj`); it can carry a preview picture of the result (`ProjectState.preview`, a PNG of at most 1 MB and 1024 x 1024 px, checked by `previewProblem`; the standalone writes 480 x 320, the same kind of image as the package's `render.png`, and a host can pass the same bytes to both). Nothing in these functions talks to a server.

3MF is the default export. Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export. Letters (any segment other than `body`) get a colour and an extruder number in the 3MF; the file never says which filament. Slicers that read per-triangle paint keep the colouring (`slicer: 'inline_sidecar'`, the default, writes both forms; see `docs/3mf-colour.md` and `docs/3mf-parts.md`). **The host chooses the slicer the file is for**: `buildPackage({ ..., target: 'prusa' | 'bambu' })` (or `write3mf(mesh, { target })`) writes what that slicer's own files carry; `prusa` is what EasyPrint needs to show every colour, `bambu` is not yet tried in Bambu Studio (`docs/3mf-colour.md` section 4c). The editor never asks the customer; without `target` the file is as before.

## 6. Apply

`applyPermanently(state, options, upTo?)` bakes the steps up to a step (or all) into the base mesh. The host must ask "This cannot be undone" first, clear its undo history when it gets the `base-replaced` event, and save. `canApplyPermanently` tells whether the button may be enabled.

## 7. What to know before relying on it

- **Limits.** `emboss` and `auto_orient` scan the mesh linearly: fine to about 500 000 triangles, slow beyond that. There is no BVH yet. Measured 2026-11-08: `emboss` with a band patch on a 506 000 triangle plate takes 2.7 s. `decimate` runs in WebAssembly by default (`engine: auto`, JavaScript fallback): 128 000 triangles to 20 000 in 0.4 s, 82 000 to 8 000 in 0.2 s. In the demo (desktop, end to end including the worker start, the font and the copy of the mesh), an emboss of "Hello world" on a 180 000 triangle sheet takes 2.1 s in Chromium and 1.6 s in WebKit. A phone will be several times slower; measure before promising a number. Limit uploads with `limits.maxTriangles` (the demo uses 2 000 000).
- **Fonts.** Static TTF, OTF and WOFF2 load directly. A variable WOFF2 font needs `loadFont(bytes, { decompressWoff2 })` from the host (the demo does not ship the decompressor).
- **Stretch.** A text is refused above 1.5 stretch and warned above 1.15. These numbers still need the visual review.
- **Meshes with bodies (groups)**: `emboss` puts the text on the body under the anchor and keeps every body's triangle range; it refuses a negative body (`emboss.on_negative_body`) and groups that do not cover the mesh (`emboss.groups_unsupported`). `decimate` reduces each body on its own (the target is split by size) in both the JavaScript and the WebAssembly version.
- **Touch.** The viewer orbits and picks with a pointer; two-finger gestures are not built.
- **Checked by hand:** a real run on a phone (2026-11-16, reported by the project owner). The 3MF was checked with a command-line slicer only; opening it in a graphical slicer is not planned.

### Low poly (`org.ateliermesh.lowpoly`)

One operation, `low_poly`: few, large, flat facets that still follow the shape. `triangles_mode` (`auto`, the default for new steps, or `fixed`; labelled "Amount"): in `auto` the plugin finds the smallest triangle count within a tolerance set by `detail` (0 to 1, default 0.5; tolerance = bounding-box diagonal x (0.08 x (1 - detail)^2 + 0.002)); in `fixed` `triangles` (the target, 12 to 200 000, default 2000) is used. A step stored by 0.1.0 migrates to `fixed`. Other settings: `sharpness` (degrees, default 40: edges sharper than this stay crisp creases; a lower angle keeps more edges), `crystallise` (0 to 1, default 0.5: pulls the corners towards the planes of the original surface so facets get flatter and corners cleaner; 0 gives the plain reduction) and `keep_borders`. It keeps a closed solid closed, keeps bodies and segments, and is not personalisable. Put it above the text steps (the order hint says so). A model that already has fewer triangles than the target comes back unchanged with the warning `lowpoly.already_smaller`; `lowpoly.target_not_reached` and `lowpoly.volume_changed` (more than 15 %) are warnings too. 30 000 to 2000 triangles takes about half a second on a desktop. The report carries `triangles_after` and `volume_change_percent`; show the volume change to a designer, because the printed part will weigh differently.

### Parts (`org.ateliermesh.parts`)

Two operations that work on the parts of a mesh: `delete_part` removes a body (group) or a coloured region (segment), `keep_part` keeps only one. The `part` parameter takes a name (`group:` or `segment:` in front when both kinds have it). Removing a region opens the surface; `close_hole: 'fill'` (the default) closes it with a cap using the repair plugin's hole filling, `none` leaves it. Removing a whole body closes nothing. Other bodies keep their order, roles and names; segment ids stay. Refused: no part chosen, removing everything, groups that do not cover the mesh. A later step that names a removed part is warned before it runs (`part.dropped`), through `outputs.drops: [{ param: 'part' }]` in the manifest. Put it right after repair (`orderHints` code `parts_first`).

### Repair mesh (`org.ateliermesh.repair`)

One operation, `repair_mesh`, for files that are not a closed solid (the load check's "Repair it" adds it as the first step). It repairs, in this order, and each part can be switched off: (1) **weld** vertices closer than `weld` mm (default 0.001; 0 off); (2) **clean**: drop degenerate triangles and duplicate triangles (a pair that faces opposite ways cancels); (3) **non-manifold edges** (`non_manifold`: `split` default, `remove`, `off`): an edge with more than two triangles keeps the two triangles that continue each other most flatly, the rest are split off or removed, and vertices on such an edge are split per fan; (4) **winding** (`fix_normals`, default on): consistent per shell, then outward by the sign of the volume; a shell inside another closed shell (a cavity) and a body of role `negative` keep the orientation they have; (5) **islands** (`min_island`, percent of the largest shell's triangles, default 1; 0 keeps all): smaller shells go, and so does any other shell with fewer than four triangles; (6) **holes** (`max_hole`, default 200 boundary edges; 0 off): each boundary loop is closed by ear clipping. A loop whose edge lies in one plane gets a flat cap; a loop with a bent edge gets that cap refined and relaxed (25 rounds of Laplacian smoothing, so a minimal surface between the loop's edges, not a flat lid). A loop whose cap would cross itself or reuse an existing edge stays open.

Groups are repaired one at a time (a repair never joins two bodies) and keep their order, roles and names; triangles keep their segment labels, and a cap takes the label most of the triangles around its hole have. The result is returned even when it is still open: `repair.still_open` is a warning, with `repair.hole_too_big` (`count`, `largest`, `max`) and `repair.hole_skipped` (`count`) saying why. Errors: `repair.bad_input` (`reason`: `no_triangles`, `not_finite`, `index_out_of_range`, `not_triples`) and `repair.groups_unsupported` (groups that overlap or lie outside the mesh). The report has before and after counts (vertices, triangles, shells, holes, non-manifold and boundary edges), `closed`, `volume_before`, `volume_after`, `volume_change_percent` (null unless both are closed), the list `did` and a counter for each repair. Measured on a desktop: 200 000 triangles with three holes, twelve turned triangles and a speck of dust, about 0.7 to 1.1 s. Limits: faces inside a solid and self-intersections are not repaired; a loose flap of four triangles or more stays as a shell (and may be closed into a thin double sheet); a hole is closed without looking at what the cap would cut through.

### Surface texture (`org.ateliermesh.texture`)

One operation, `texture`: the surface moves along its normal by a pattern height (`amplitude` mm, `scale` mm per tile). The surface is cut finely enough first (edges about a quarter of the pattern's smallest feature, never below 0.15 mm), so the result can be 50 000 to a few hundred thousand triangles; the step is refused with `texture.too_heavy` above `max_triangles` (default 1 000 000), with a button that sets `detail` to `coarse`. A closed solid stays closed; `texture.may_self_intersect` warns when the depth is large against the bend of the surface. `edge_falloff` (default 1 mm) fades the texture before sharp edges. `segment` can label the textured triangles for multicolour slicing. The picture pattern needs the host to supply the image bytes through `assets` (a PNG decodes everywhere; a JPEG needs `createImageBitmap` and `OffscreenCanvas`). Put it above text steps. See `SPEC.md` 5A.12.

### Print check (`org.ateliermesh.printcheck`)

One operation, `printability`, an analyzer: put it last (the order hint says so). Its report has `verdict` (`good`, `fix_recommended`, `not_printable`), `score` (0..100) and `findings`, one per check, each with a `severity`, a number or two (`value`, `share`) and, when places can be shown, `triangles` as runs for the viewer. Findings that are warnings or errors are also warnings of the step (`printcheck.thin_walls` and so on, texts in `mesh.printcheck.*`). In the editor the settings pane shows a card (`PrintReportCard`, or `PrintReport` with a `report` and a `viewer` for your own page): a verdict, a score, a line per finding with a dot, and **Show in 3D** which highlights the flagged triangles with `Viewer.highlight` (it is enabled only when the view shows the mesh this step checked, so the step must come last). The texts are the `printcheck.*` and `mesh.printcheck.*` keys. The check also finds parts that start in mid-air (`floating_body`, `island`) and overhangs and bridges that need support (`overhang`, `bridge`), with a suggested way up (`turn`, `from_area`, `to_area`, `turn_x/y/z` in the finding's `params`); these four have their own highlight colours in the card. A server can run the same check on a customer's final mesh (`printCheck(mesh, options)` from `@ateliermesh/plugins`), for example to refuse a model that is not closed or does not fit the printer.

### Hollow (`org.ateliermesh.hollow`)

One operation, `hollow`: a closed model gets a cavity and a wall of `thickness` mm (default 2). Without an opening the outside of the model is **untouched** (every vertex and triangle, the letters of a text step, a texture), and the inside is a smooth surface of its own with the segment `cavity` (empty `cavity_segment` for none; a 3MF export gives a segment other than `body` its own colour and extruder number). With an opening (a round hole along Z through the top and/or the bottom) the outside is made again from the model. Bodies are hollowed one by one. It is closed solid in, closed solid out; a model that is not closed is refused (add Repair mesh first). Put it below text, texture and pattern steps and above a Voronoi shell (the step list says so). Method, parameters, errors and numbers: SPEC 5A.13.

### Cheese (`be.micro-fabriek.cheese`, a plugin of its own, not built in)

Source, tests and texts: kept in the plugin factory (version 1.0.0, 2026-11-17); this repository no longer holds them. The Atelier installs the packed file. The behaviour below is its specification. The standalone app installs a package like it from the plugin manager (a file or a catalog); its manifest says `"replaces": ["org.ateliermesh.cheese"]`, so designs saved with the old built-in step keep working.

One operation, `cheese`: `part` (make holes only through this segment or group; empty = the whole surface), `holes` round holes (default 40) with radii between `min_radius` and `max_radius` (0 = chosen for the model), `overlap` (0..1, how often holes overlap and merge, default 0.3), `seed` (the arrangement; personalisable together with `holes`), `min_wall` (the thinnest wall, default 0.8 mm), `smooth` (rim rounding) and `detail`. The result is one closed solid. Holes overlap freely: the part removed is the union of the spheres, and no void is ever isolated (an inner hole is only made when it overlaps another hole). Holes are cut into the surface exactly (the triangles near them are split, the ones inside are removed and the sphere patches that close the openings are triangulated from the cut loops), so every triangle that is not near a hole is unchanged, with its text, texture and colour parts; with `part` set, the faces that are not selected keep every triangle. The report counts holes requested, placed and the ones left out by reason. Hints: put the step below text, texture, pattern and twist steps and above a Smooth surface step. Several bodies are fine: `part` = a body cuts holes in that body only, empty gives every body holes (the total split by area); bodies must not overlap, and each must be closed. Needs a closed solid (use Repair mesh first).

### Deform (`org.ateliermesh.deform`)

Two operations, `twist` and `taper`: every slice of the model across an axis (`z` by default) is turned (twist, `angle` in degrees) or scaled (taper, `scale_end`: the size at the end relative to 1 at the start). `from` and `to` (0 to 1 of the height) limit the range; outside it the model moves as a whole, so nothing tears. `easing` is `linear` or `smooth`. `angle` and `scale_end` are personalisable, so a customer can slide them.
- **Closed solid:** the maps are one-to-one, so a closed solid stays closed. The mesh is first cut by planes across the axis, as many as the tolerance needs (0.02 mm by default; `detail`: `fine` a quarter of it, `coarse` four times), and groups and segments are kept.
- **Cost:** a 360 degree twist of a 2400 triangle cylinder becomes 146 000 triangles in 0.3 s (desktop, Node). The result is refused with `deform.too_heavy` above `max_triangles` (default 1 000 000); follow it with Low poly if you need a light file.
- **Problems:** `deform.may_fold` (warning, hard bend), `deform.too_heavy`, `deform.bad_range`. Put it above text steps and below repair.
- **Bend, wave and ripple (0.3.0):** `bend` (`angle`, `axis` = the length direction, `bend_axis` = the direction it folds towards) is the exact closed-form bend round a circle, so a bar bent by 90 degrees keeps its volume within 0.1 %; `wave` (`amplitude`, `wavelength`, `axis`, `direction`, `falloff`) and `ripple` (`amplitude`, `wavelength`, `decay`, `radius`, `center`) move the surface along an axis (a shear: closed, same volume, thickness kept). Wave and ripple refine by splitting edges until the sine is followed (an edge of at most `lambda / 16`); a 100 x 100 mm plate with 8 mm rings is 82 000 triangles in 0.3 s at `detail: coarse` and about 300 000 at the default. Extra problems: `deform.bad_axes`, `deform.bad_wavelength`, `deform.wave_too_big`. The customer can be handed `angle` (bend) or `amplitude` and `wavelength` (wave, ripple).

**Smooth surface (`smooth`).** Evens out the surface of any mesh without shrinking it and without changing a triangle, group or segment: only vertex positions move (Taubin lambda|mu smoothing). `strength` (0 to 1, personalisable), `iterations` (default 10), `keep_edges` (degrees: edges that turn by more than this stay crisp and are smoothed along their length; 180 smooths everything), `keep_volume`, `keep_borders`, `max_move` (mm) and an optional `part` with a `falloff`. 1 000 000 triangles with 10 iterations take 0.9 s (desktop, Node). It belongs below a Voronoi shell, a texture or a twist (those make the rough surface) and above the text steps (it would round the letters); `orderHints` says so with `smooth_before_surface` and `smooth_after_text`. Thin parts wear away when smoothed hard: `smooth.thin_features` warns, and `max_move` caps how far a point may go.

### Voronoi pattern (`org.ateliermesh.voronoi`)

One operation, `voronoi`: a Voronoi pattern on the surface, made with the same engine that puts text on a surface (it is unfolded onto the surface, imprinted and lifted), so it works on flat and gently curved parts and has the same modes. `personalisable: 'optional'`; the placement, `cells` and `seed` can be handed to the customer (a customer shuffles the pattern with `seed`). The placement's anchor is the centre of the area.

- **Area:** `region` (`rectangle` or `circle`), `width` and `height_area` (rectangle, mm) or `radius` (circle, mm), `margin` (clearance from the edge of the area, default 1 mm).
- **Pattern:** `cells` (about how many, 2 to 2000, default 40), `seed` (0 to 999 999, default 1: the same seed gives the same pattern on every machine, no `Math.random`), `irregularity` (0 to 1, default 0.6: 0 relaxes the cells to an even, honeycomb-like pattern, 1 keeps the random seeds), `line_width` (mm, default 1.2: the gap between two cells), `fill` (the cells themselves are the shape, with a gap of one line width between them; default off: the lines between the cells are the shape), `rounding` (corner radius of the cells, mm).
- **Shape:** `mode` (`raised`, `engraved`, `flat`), `height`; `segment` (the top, floor or flat area, default `voronoi`) and `walls_segment` (the side walls, default `voronoi_walls`) as in `emboss`; `min_stroke` and `min_wall` as in `emboss`.
- **Problems** (codes `voronoi.*`): `cells_too_small` (error, carries `max_cells`), `too_many_cells` (error), `too_heavy` (error: more than 60 000 outline points), `empty_pattern` (error), `does_not_fit` (error: the area reaches an edge or a part that curves too much; `reason` has the cutter's code), `thin_lines` (warning, carries `min_line`). The cutter's own stretch warnings pass through, and the runner's triangle limit applies to the result (`budget.triangles`).
- **Cost:** the pattern itself is quick (30 ms for 40 cells, 0.1 s for 300, 0.6 s for 1000, 1.2 s for 2000); the cut is what costs. Measured on a desktop (Node): 40 cells about 2 s, 300 cells 3.8 s, 1000 cells about 5 s on a 70 x 30 mm plate of 40 000 triangles; 2000 cells at 0.5 mm lines on a 110 x 110 mm area gave 586 000 triangles and took 29 s, so a site limit of 1 000 000 triangles is reachable. `orderHints` treats a Voronoi step like a text step: reducing triangles above it is suggested.

### Voronoi shell (`org.ateliermesh.voronoi`, operation `voronoi_shell`)

Hollows a closed model into a lattice: a wall of `thickness` mm under the outside, cut into struts of `rib_width` mm around `cells` irregular openings, with rounded joints (`smooth`) and, if wanted, a round opening along the vertical (Z) axis through the top and/or the bottom (`opening` `bottom`, `top` or `both`, `opening_diameter`) with a collar round its edge. It is an implicit surface (signed distance, a Voronoi field, marching tetrahedra), so it works on any closed model and always returns a closed manifold solid. `personalisable: 'optional'`; only `cells` and `seed` can be handed to a customer (a customer can shuffle the pattern or choose its density). Put Repair mesh before it for a file that is not closed; a model with several bodies is refused. Segments and groups are dropped, so a later step that names one gets the usual part warning; put text steps before the shell, never after.

- **Quality and cost:** `detail` (`auto`, `fine`, `coarse`) sets the voxel size (a third of the thinnest of wall and strut); a preview run uses voxels twice as big. Measured on a desktop (Node), a 50 mm ball with the defaults (2 mm wall, 2 mm struts, 60 cells): preview 0.35 to 0.7 s (voxel 1.33 mm, 35 000 triangles), export 1.3 to 1.5 s (voxel 0.67 mm, 153 000 triangles; the distance field is 85 % of that time), fine 3.9 s (318 000 triangles); a 100 mm ball takes 1.7 s in preview and 4.5 s for export (331 000 triangles). More than 60 million voxels is refused (`voronoi_shell.too_heavy`, with a "Use coarser detail" button), and the result is reduced with the decimation engine above `max_triangles` (default 600 000).
- **Problems** (codes `voronoi_shell.*`): `bad_input`, `groups_unsupported`, `cells_too_small` (carries `max_cells`), `too_heavy`, `empty_result` (errors); `thin_ribs`, `thin_wall` (below 0.8 mm), `thickness_too_big` (warnings).
- **Sample:** `docs/samples/voronoi-shell-example.3mf` (a tapered vase 50 mm high, open at the top, then smoothed, 60 000 triangles), made by `scripts/make-voronoi-shell-sample.ts`; the standalone app has it as the first sample card, "Voronoi shell".


## 7b. A plugin that crashes

An exception the plugin did not mean, a failed import or a dead worker comes back as `plugin.crashed` (`plugin`, `name`, `version`, `op`, `step`, `phase`, `message`), and `runWorkflow` switches the plugin off in the registry (pass `deactivateOnCrash: false` to decide yourself; `onPluginCrash` and `result.crashedPlugins` tell you which). The plugin's steps then fail with `plugin.disabled` and the steps before keep their results. `registry.setEnabled(id, true)` switches it on again (and forgets the code that failed to load); `registry.disabledPlugins()` lists the reasons; `registry.subscribe(cb)` and `registry.version` tell a UI to draw again (`useRegistryVersion(registry)` in `@ateliermesh/react`). `EditorPage` shows a banner (`CrashBanner`), the plugin manager shows each plugin's state (`PluginRow.disabled`, `onToggle`), the Add-step menu drops the plugin, and `PersonaliseOverlay` gives the customer one calm sentence (`mesh.plugin.customer`). `probePackage(pkg)` in `@ateliermesh/loader` starts a package once before you add it, so a plugin that cannot load never reaches the list. The standalone remembers switched-off plugins in `localStorage` (`am.disabledPlugins`). Nothing here is for the Atelier's server.
## 8. Versions and deprecation

Plugin API and manifest have a version (`manifest_version: 1`). The current and the previous major version are supported together. A feature is announced as deprecated one major version before it is removed, and `CHANGELOG.md` says so. A project saved with an older plugin version runs through the plugin's `migrate` function.

## 8b. Plugins from other people

A host can offer plugins it did not build. **Nothing of AtelierMesh is published to npm** (the packages are the tarballs of `npm run pack`), and the npm package called `amplugin` is an unrelated project: the packing tool is `tools/amplugin.mjs` in the plugin kit. Plugin authors outside the repository work from the **plugin developer kit** (`npm run kit:plugin`, or the zip the standalone offers under Plugins, *Build your own plugin*; `npm run check:kit` proves it works from the zip alone). They follow [`docs/plugin-guide.md`](docs/plugin-guide.md) (a coding agent can start from [`docs/prompt-make-a-plugin.md`](docs/prompt-make-a-plugin.md)); the host side is `docs/external-plugins.md`. Two things a host owner must do for a third-party plugin: add its texts to the language files (a package's own `locales/` are not read yet), and list its warning codes if they should show as warnings (`WARNINGS` in `packages/ui/src/problems.ts`).

## 8c. A plugin catalog
The standalone app can search and install from a catalog (SPEC section 4B) and mark installed plugins that have a newer version. It is a prop of the shared screens, so another host can bring its own: `PluginManager` takes `catalog?: PluginCatalogHost` (`status`, `source`, `items`, `updates`, `busy`, `onInstall`, `onOpen`, `onRetry`), and `SettingsDialog` / `EditorPage.settings` take `catalog` for an address field. The manager only shows and calls back; the host reads the catalog (when `onOpen` is called, never in the background), downloads the version with its checksum pinned (`fetchPluginBytes('<url>#sha256=<hash>')`), checks that the package is the plugin and version the catalog named, and then runs its normal approval before adding anything (`apps/standalone/src/catalog.ts` and `App.tsx` are the reference). The standalone's server part is `apps/standalone/server/catalog/` (PHP 8.0+, optional; `npm run test:catalog`).

## 9. Gates

`npm run check` (typecheck, lint, unit tests), `npm run test:coverage -w @ateliermesh/core` and `-w @ateliermesh/plugins` (80 % line gate), `npm run check:packages` (the tarballs in a clean project), `npm run licenses` (permissive licences only), and the demo's journey test in Chromium and WebKit (`npm test -w @ateliermesh/demo`).

## The personalise overlay (React)

`@ateliermesh/react` has two screens, `EditorPage` (the designer's and the standalone editor, below) and `PersonaliseOverlay`: what a customer sees after pressing the pen button on the Atelier's preview. It is full screen, with **Reset** and **Done** on top, the steps the designer opened on the left, the live model in the middle and the opened fields on the right. It follows design handoff v4.2.

```tsx
import { PersonaliseOverlay } from '@ateliermesh/react'
import '@ateliermesh/react/overlay.css'   // optional default look; it reads CSS variables (--am-bg, --am-accent, ...)

<PersonaliseOverlay
  list={designerStepList}          // the designer's version; Reset returns to it
  registry={registry}              // the same Registry the engine uses
  run={(list, { signal }) => runWorkflow(list, { registry, host, source, signal, quality: 'preview', assets })}
  t={(key, values) => i18n.t(key, values)}   // design's keys: overlay.*, text.*, size.*, pos.*, mesh.*, fix.*, work.*
  three={THREE}                    // the host's three.js, never a second copy
  fonts={[{ id: 'roboto', family: 'Roboto' }]}   // the fonts the customer may pick, loaded by the host
  onDone={list => saveCustomerStepList(list)}      // called only when the last run was good
  onClose={() => closeOverlay()}
/>
```

What it does for you:
- Shows only the personalisable fields (a placement can be open for direction, for position, or both); every control stops at the designer's limits: typing at the lines and characters, the letter height at its range, direction buttons outside the range are disabled, the nudge arrows at "move at most".
- Runs the workflow after each change (debounced), keeps the last good model on screen when a step fails, and shows the engine's problem with its way out (a button such as "Make it 7 mm" when the engine named a size).
- **Done** waits for a running step (shows "Finishing…"), closes only when the result is good, and is disabled while an error stands. Warnings never block it.
- `previewAsCustomer` shows the designer the same overlay with the band "Preview as customer".

What stays with the host: running the workflow (workers, assets), the language files, three.js, font loading, the price and the quote. The overlay never sees a material.

The component is tested in Chromium and WebKit with the real engine (`packages/react/test`), including an axe-core run (WCAG 2.1 AA, best practice), and ships in the package gate (`npm run check:packages` installs it in a clean project with React 18).

## The editor page (React)

`EditorPage` is the step list on the left, the 3D view in the middle and the settings of the selected step on the right. On a phone (768 px and narrower) the view fills the screen and the list and the settings sit in a **bottom sheet** with three heights (peek, half, full); the handle is a button, and dragging it snaps to the nearest height.

```tsx
import { EditorPage, useProjectSession } from '@ateliermesh/react'
import '@ateliermesh/react/overlay.css'
import '@ateliermesh/react/editor.css'

// the project: model, steps, the store of drawings and models, undo and redo, running the steps, Apply (no storage and no files: those stay yours)
const session = useProjectSession({ registry, host, cache, assets, maxTriangles: 2_000_000 })
// session.start(mesh, 'plate.stl') when a model is opened; session.doc is the project, session.projectBytes(doc, { assets, plugins }) the project file

<EditorPage
  t={t} registry={registry} three={THREE}
  list={session.doc.list} onListChange={session.onListChange}   // or keep the list yourself: then you own undo and saving
  run={session.run}                                // or call runWorkflow yourself
  source={session.doc.base} baseParts={{ segments, groups }} file={{ name: 'plate.stl', width: 140 }}
  mode="designer"                                  // or "standalone"
  personalised={design.personalised} onPersonalised={setPersonalised}
  settings={{ showPersonalised, onShowPersonalised }}   // standalone: the Settings dialog and its one option
  plugins={{ plugins: rows, onLoadFile, onLoadUrl, onRemove }}   // the plugin manager; you load packages with @ateliermesh/loader
  actions={<button>Next: preview</button>}         // top bar: export, save, preview as customer
  aside={<AtelierColumn />}                        // the Atelier's own column under the step settings
  dirty={dirty} savedAt="14:32" onSave={save} onLeave={openAnotherFile}
/>
```

- **Step names.** A step can carry a `name` (up to 80 characters) that the designer types in the step's settings. The step list, the settings title and the customer overlay show it instead of the operation's title; empty means the operation's own title. It is not part of what a step computes (same cache key), and a customer cannot change it (the server check refuses a changed name as a changed structure).
- **Waiting.** A run that lasts longer than 400 ms shows, under the view, the AtelierMesh loader, the stage of the running step ("Step 2 of 4 · Fitting the text to the surface…"), a thin bar and **Stop**; the last good model stays on screen, dimmed, and the running step's dot pulses. A quick run shows nothing. A polite live region says "Working" once at the start and "Done" once at the end. Reduced motion: the label and a still loader. To get the stage names and the bar, pass the engine's progress on: `run={(l, { signal, onProgress }) => runWorkflow(l, { ..., signal, onProgress })}` (`onProgress(stepId, stage, fraction)`; without it the row only says "Working…"). **Stop** aborts the `signal`; the stopped step reads "Stopped" and the previous result stays. The same row is in the personalise overlay.
- **One form for every operation.** The settings of the selected step are drawn by one renderer (`StepForm`) from the manifest: field types, limits, units, `widget`, `importance`, `icon`, `help`, and the operation's `icon` and `summary`. A plugin, built in or third party, gets the designed form without any UI code; see "How it looks" in `docs/plugin-authoring.md`. The generated panel in `@ateliermesh/ui` stays for hosts without React, and only an operation with a parameter this form cannot draw (a painted `selection`) falls back to it.
- **Add a step** lists every operation of every registered plugin under its heading (a plugin that has an `icon` and three or more operations under one heading is one row with a submenu), with a search field above 12 operations, a "More" group for operations with `importance: 'low'`, the last three used, and "Plugins…" when `plugins` is given. A step that cannot be added at this point (a drawing step on a model, `load` with an empty store) is shown disabled with the reason; tell the menu what the last step produced with `kind` and how many stored items there are with `storeEntries` (`EditorPage` does the first).
- **Opening a file.** `useOpenFile` (reading with progress, unit, simplify, closed-solid check and Repair, out of memory, `.amproj` projects) is the one implementation the standalone app and the Atelier share; see `docs/proposals/atelier-adopt-shared-hooks.md`. **The waiting icon** is the AtelierMesh loader unless the screens are wrapped in `LoaderIconProvider`.
- **Running a list without a document** (a preview, an overlay, quote files): `createRunner({ registry, host, assets, maxTriangles, ... }).runList(list, { source, store, rollback, quality })` from `@ateliermesh/core`; the session hook runs through it, so the behaviour is the same.
- **The project hook.** `useProjectSession(runtime, { initial, onChange, shortcuts })` (see the code above) is the project logic the standalone app uses, so another host gets the same undo, store, run and Apply behaviour. It has no storage or file handling.
- **Order** by dragging, or with Move up / Move down (announced to a screen reader). Soft tips (analyzers last, decimate and size/rotate above text) come with one button that fixes them; **part warnings** appear on a step that names a part nobody makes (`part.not_produced`, needs `baseParts`) or one an earlier step dropped (`part.dropped`).
- **Up to this step** shows the model after that step only, with a note and a way back.
- **Personalised design** switch: always in designer mode; in standalone mode only when `settings.showPersonalised` is on. Off, nothing about personalisation shows. Switching it off with personalisable steps asks first, then clears them.
- **Dialogs** (also exported on their own): `PluginManager`, `SettingsDialog`, `LeaveDialog` (Escape does not answer it), `Dialog` for your own. They report what the user chose; loading a package, saving and remembering a setting stay with the host. `useLeaveGuard(dirty)` warns the browser before a reload.
- **"Build your own plugin"** is an info panel inside `PluginManager` (a second view in the same dialog: what a plugin is, what you need, five steps, a note on the sandbox, with a back button; Escape goes back first). It shows when you pass `plugins={{ ..., build: { guideUrl, promptText, exampleUrl, kitUrl } }}` and is hidden without `build`. `guideUrl` opens in a new tab (`rel="noopener noreferrer"`), `promptText` feeds a "Copy a prompt for your AI agent" button (clipboard API, then a hidden-textarea copy, then a selectable text box when a page has no clipboard, as on plain http), `exampleUrl` is a download link for the packed example (to try the loader) and `kitUrl` one for the plugin developer kit (a zip). Every part is optional. The standalone builds all three at build time: `apps/standalone/build.mjs` renders `docs/plugin-guide.md` and `docs/prompt-make-a-plugin.md` to `dist/docs/*.html` (own small renderer, `apps/standalone/tools/docs.mjs`, everything escaped), writes the quick prompt out of the markdown into the bundle (so it cannot drift), and packs `examples/plugins/mirror-full` to `dist/docs/mirror-example.amplugin` (no download button when packing fails). The guide stays English. The Atelier can pass its own URLs, or leave `build` out.
- Texts: design's keys; `order.partMissing` and `order.partDropped` and a few plugin-dialog words (`plugins.url`, `plugins.file`, `plugins.keys`, ...) have English fallbacks until design writes them.

The panel also has a segmented choice "With npm / Without npm" (`build.promptTextNoNpm`, texts `plugins.build.variant|withNpm|withoutNpm|noNpmHint`) that switches the copied prompt to the no-npm variant (plain JavaScript, tools that need only Node, only Python 3 or only a shell). A host that passes only `promptText` shows no choice.

Tested in Chromium and WebKit, including an iPhone WebKit profile for the sheet, with axe-core (WCAG 2.1 AA).

## The pages around the editor (React)

`UploadPage`, `UnitsDialog`, `LoadCheckDialog`, `ProjectListDialog` and `CannotRunView` are the screens before and around the editor. They show and report; the host reads the file, measures the mesh (`parseStl`, `read3mf`, `unitHint`, `convertToMm`, `measureMesh`), keeps the storage and decides what happens next. `apps/standalone/src/App.tsx` is a complete example (about 400 lines): the opening flow is upload, then units (STL only), then the checks (too detailed, not a closed solid, unreadable), then `EditorPage`.

```tsx
import '@ateliermesh/react/theme.css'     // only for a host without the design tokens; the Atelier has its own
import '@ateliermesh/react/overlay.css'
import '@ateliermesh/react/editor.css'
<UploadPage t={t} journey="B" onFile={openFile} />                       // journey A adds samples and saved configurations
<UnitsDialog t={t} suspect={hint.suspect} size={u => sizeIn(u)} onContinue={unit => ...} onBack={...} />
<LoadCheckDialog t={t} kind="manifold" onOpenAnyway={...} onOther={...} />   // or triangles, toolarge, unreadable
```

`EditorPage` takes `brand` and `crumbs` for the standalone's dark top bar (the Atelier leaves them out and uses its own bar), places text when the user clicks on the model after pressing the placement button in the settings, and shows direction and nudge controls for a placed text.

## Opening a file: progress, loader and Stop

Reading a big STL or 3MF takes seconds. The parsers can report how far they are and let the page draw while they work, so a host shows the loader instead of a frozen page:

```ts
import { parseStlAsync, read3mf, measureMeshAsync } from '@ateliermesh/core'
const ac = new AbortController()
const { mesh } = await parseStlAsync(bytes, { maxTriangles, signal: ac.signal, onProgress: f => setBar(f) })   // f: 0 to 1, never goes back, ends at 1
const solid = (await measureMeshAsync(mesh, { signal: ac.signal, onProgress })).watertight
```

- `parseStlAsync`, `read3mf`, `loadProject`, `weldSoupAsync` and `measureMeshAsync` take `{ onProgress, signal }`. The synchronous `parseStl`, `weldSoup` and `measureMesh` are unchanged and give the same results. Stopping rejects with an `AbortError` and leaves nothing behind.
- `boundingSize(mesh)` is the cheap size check (one pass over the vertices); `unitHint` uses it.
- The work runs on the main thread in chunks of about 60 000 triangles (a few milliseconds each). Between chunks `tick()` lets timers, React and, about every 80 ms, a frame run. It does not use `scheduler.yield`, whose continuation would starve the page's own updates. Measured on a 1.3 million triangle STL (65 MB, Chromium): the longest main-thread block went from 688 ms to about 70 ms (the unit check and the closed-solid check were the two big ones).
- `@ateliermesh/react` has the screens: `useLoading()` (state, `begin()` returns the AbortSignal, `set(stage, fraction, bytes)`, `end()`, `stop()`), `LoadingView` (the page, after 300 ms), `LoadingRow`, `SimplifyingDialog` and `SimplifiedDialog`. The standalone (`apps/standalone/src/App.tsx`, `readFile.ts`) is the worked example: read bytes with a progress bar, parse, ask the unit, check, simplify.
- Texts: `loading.*` (see `docs/design-texts-loading.md`). The loading bar is `role="progressbar"` with `aria-valuenow`; a polite live region says "Working" once and "Done" once.


## Recipes (a designer's template)

A recipe is an export of the steps you have, without the model: the step list in its order, the plugins it uses, a name and a date, as plain JSON (`.amrecipe`). The functions are pure (no DOM, no storage), so the Atelier can keep the same JSON in its database as a designer's template.

```ts
import { makeRecipe, serializeRecipe, parseRecipe, recipeProblems, applyRecipe } from '@ateliermesh/core'

const recipe = makeRecipe({ name: 'Name on the lid', list })           // all the current steps, in order
const text = serializeRecipe(recipe)                                    // store this (file, browser, database)

const parsed = parseRecipe(text)                                        // strict; never throws
if (!parsed.ok) show(parsed.errors)                                     // { code: 'recipe.*', params, path }
const problems = recipeProblems(parsed.recipe, registry)                // missing plugins, other versions, unknown operations
const { list: next, added, skipped } = applyRecipe(list, parsed.recipe, { skipMissing: true, registry })   // appended in the recipe's order, new step ids
```

In `EditorPage` pass `recipes={{ entries, load, save, remove, openFile }}` (the list, the storage and the files stay with the host) and the Add-a-step menu offers "Apply a recipe…" and "Save as a recipe…". Applying is one change (`onListChange(list, 'recipe')`, one undo step); a text step that needs a place on the model is selected and the click-to-place mode starts. Limits: 1 MB of text, 100 steps, 2 MB of embedded images or SVGs (never fonts). See SPEC 10A.
