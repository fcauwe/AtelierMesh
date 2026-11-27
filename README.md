# AtelierMesh

**A way for web apps that make or edit 3D-printable files to share plugins.** A customer clicks a model, types a text, and it is raised or engraved into the mesh itself: one mesh, one closed surface, following the curves; no boolean operation, no image. Everything runs in the browser. There is no backend you must run, and your files stay on your computer.

**Try it: [https://ateliermesh.app/](https://ateliermesh.app/)** runs the standalone app in your browser; your files stay on your device.

AtelierMesh is made by [micro-fabriek.be](https://micro-fabriek.be) and shared as open source. This repository holds the engine, the built-in plugins, the shared screens, and a standalone app.

> **Status:** version 0.4.8, a public copy made on 2026-11-27 from the private development repository (commit `af5cdab`). Nothing is published on npm: the packages are built from this source (see below). The npm package called `amplugin` is a different, unrelated project; do not install it.

**Landing page:** https://fcauwe.github.io/AtelierMesh/ (published with GitHub Pages: in the repository settings choose Pages, Source: GitHub Actions). It has the short story, a link to the running app and **[How plugins work](https://ateliermesh.app/how-plugins-work.html)**, the pictures of the plugin framework.

## What it is

- **A workflow engine** (`packages/core`): a list of steps, each one an operation of a plugin, run on a mesh with a cache so that changing step 3 of 5 runs only steps 3 to 5. Validation for the designer and for the customer, undo history, a project file (`.amproj`), recipes (the steps without the model), STL and 3MF with colours, and a worker host.
- **Built-in plugins** (`packages/plugins`): raised or engraved text and SVG that follow the curves, resize, rotate, auto-orient, reduce triangles (JavaScript and WebAssembly), low poly, holes and pockets, hollowing, deformations (twist, bend, taper, wave, ripple), textures, a Voronoi pattern, repair, delete or keep a part, and a printability check.
- **Outside plugins** (`packages/loader`): `.amplugin` packages with hashes and signatures, loaded in a sandbox with no network, and the `amplugin` tool to make them. Anyone can write one: see [`docs/plugin-guide.md`](docs/plugin-guide.md), or give [`docs/prompt-make-a-plugin.md`](docs/prompt-make-a-plugin.md) to your coding agent. The **plugin developer kit** (`npm run kit:plugin`) holds everything needed to write, test, pack and load a plugin without this repository.
- **Shared screens** (`packages/react`, `packages/ui`): the editor, the customer's personalise overlay, the upload page, the units step, the load checks, the plugin manager and a three.js viewer. A host app (like the standalone app) puts them together.
- **A standalone app** (`apps/standalone`): upload an STL or 3MF, add steps, preview, export a 3MF for PrusaSlicer or Bambu Studio, save projects in the browser, install plugins from a file, an address or a catalogue, browse and share examples.

The specification is [`SPEC.md`](SPEC.md); how a web shop adopts the packages is [`INTEGRATION.md`](INTEGRATION.md); the changes are in [`CHANGELOG.md`](CHANGELOG.md); the documents are listed in [`docs/README.md`](docs/README.md).

## Try it

You need Node 24 or newer.

```
npm install
npm run build:standalone                # apps/standalone/dist: a static site
npx --yes serve apps/standalone/dist    # or any static file server, then open it
```

Checks:

```
npm run check            # typecheck, lint and all tests (browser tests need Chromium and WebKit from Playwright)
npm run pack             # tarballs of the packages in build/tarballs
npm run check:packages   # the tarballs installed into a clean project
npm run licenses         # runtime dependencies: permissive licences only
```

## The repository

| Folder | What |
|---|---|
| `packages/core` | The engine, with no UI |
| `packages/plugins` | The built-in plugins |
| `packages/ui` | The 3D viewer and small helpers (three.js is a peer dependency) |
| `packages/react` | The shared screens |
| `packages/loader` | Outside plugin packages and the `amplugin` tool (MIT) |
| `apps/standalone` | The standalone app |
| `apps/cli` | The command line: run a recipe on a model without a browser (`docs/headless.md`) |
| `examples/` | A server-side check and example plugins (`plugins/mirror`, `plugins/mirror-full`, a plain JavaScript one) |
| `scripts/` | Build, pack and check scripts |
| `docs/` | The guides |

## Licence

AtelierMesh is **dual licensed**: by default the **GNU AGPL-3.0-or-later** ([`LICENSE`](LICENSE)); another licence can be agreed on request. A plugin made with the plugin kit can have any licence (the kit is MIT, [`LICENSE-KIT`](LICENSE-KIT)), and the Plugin Interface may be copied into a plugin under an additional permission. The full text and the details are in [`LICENSING.md`](LICENSING.md). Third-party fonts and icons keep their own licences (listed in `LICENSING.md` and next to the fonts).

## Contributing and security

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first: until a contributor agreement is in place, open an issue rather than a pull request. To report a security problem, see [`SECURITY.md`](SECURITY.md).

## About this copy

This repository is generated from the private development repository by a script that copies the source, the tests and the public documents, and leaves out working papers, design rounds and anything that looks private. The history of the private repository is not part of it. Files that this copy points to but does not contain (for example a few working papers named in code comments) are not needed to build or test.
