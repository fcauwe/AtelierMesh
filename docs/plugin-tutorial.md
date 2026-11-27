# Writing and packaging a plugin: a ten-minute tutorial

> The full guide, with a worked example, tests and a checklist, is [`plugin-guide.md`](plugin-guide.md).

The example is `examples/plugins/mirror`. Read `docs/plugin-authoring.md` for the exact interfaces and `docs/external-plugins.md` for how the standalone demo loads a package. A plugin loaded this way runs in a sandbox with no network; plugins built into the Atelier are first-party and compiled in.

1. **Manifest** (`manifest.json`): an id in reverse-domain form, a version, and the operations with their parameters. The panel is generated from it: types, limits, units and `visible_if` conditions need no UI code. Run `validateManifest` on it (the packaging tool does).
2. **Code** (`main.ts`): `export default { async run(op, ctx) { ... } }`. The mesh in `ctx.mesh` is `{ positions: Float64Array, indices: Uint32Array, segments? }` in millimetres, Z up. Return `{ mesh?, report?, warnings? }` with a **new** mesh, never changed arrays. Throw `new Error(...)` or, if you bundle `MeshError` from core, a structured `{ code, params }` error. Report progress with `ctx.progress(stage, fraction)` and stop when `ctx.signal.aborted`.
3. **Pack**: `node packages/loader/bin/amplugin.mjs pack examples/plugins/mirror --out mirror.amplugin` (after `npm run gen -w @ateliermesh/loader`). TypeScript is compiled and bundled into one module. Add `--key me.key` to sign it (`amplugin keygen me` makes the key pair; the person loading it adds your public key under "Trust a key").
4. **Try it**: open the demo, "Plugins", "Load .amplugin…", approve the dialog, choose the operation in "Add step". `amplugin inspect mirror.amplugin` shows what the loader sees.
5. **Check it**: write a fixture (`Fixture` in `@ateliermesh/core`): an input mesh, steps and expected sizes and volumes with tolerances, and run `runFixtures`. The built-in plugins' fixtures are in `packages/plugins/src/fixtures.ts`.

Rules the sandbox enforces: no network (`fetch` fails), no DOM, files only through `ctx.assets("pkg:<id>/<path>")`, a time limit per step, and every mesh you return is checked (finite numbers, indices in range, a triangle budget). WebAssembly works: ship the `.wasm` under `assets/` and instantiate it from the bytes.
