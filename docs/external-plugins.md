# Loading external plugins in the standalone app

Status: **built** (milestone M7B, 2026-11-08) in `packages/loader`, used by `apps/standalone`. Section 6 records what the build found. Decision 2 of `PLAN.md` ("first-party, compiled in") still holds for the Atelier. The standalone app adds a second way in: a package the user loads at runtime. Both ways give the registry the same thing, a manifest and a module, so nothing else in the engine changes.

## 1. Package

A ZIP named `<id>-<version>.amplugin` (`SPEC.md` §3):

```
manifest.json     required (must have license and description; may have contact and package_url, see plugin-guide.md section 3)
main.js           ES module, default export is a PluginModule; no imports from outside the package
assets/           fonts, textures (read through ctx.assets), and the optional example picture named by manifest `image` (PNG, JPEG or WebP, 300 KB at most)
manifest.sha256   optional: hash of every file
manifest.sig      optional: signature of manifest.sha256
```

`main.js` must be self-contained (bundled). It may import `@ateliermesh/core` types only (erased at build time); it gets `MeshError` through `ctx` if needed, or its own copy.

## 2. Load sequence

1. The user picks a file **or enters a URL** (decided: both are allowed). Size cap (default 20 MB compressed, 60 MB expanded; refuse ZIP bombs by counting while inflating).
   A URL must be `https:` in production. In development mode (a host option, off by default) `http:` is also accepted, for any host, so a plugin can be served from a local machine or network. The host fetches it itself (so the server must send CORS headers), with `credentials: 'omit'`, no redirects to another scheme, and the same size cap, counted while streaming. A link may carry `#sha256=<hash>`: if present, the downloaded file must match it, which lets a link be shared with integrity. The origin is shown in the approval dialog (step 5) and stored in `plugins.lock.json` with the package hash.
2. Unzip in memory. Reject paths with `..`, absolute paths, or duplicates.
3. `validateManifest`. Refuse if invalid, if the id clashes with a built-in plugin, or if the id is already loaded at the same or a higher version.
4. If `manifest.sha256` is present, check every file hash (`sha256Hex` from core). A mismatch refuses the package. If a signature is present, verify it with WebCrypto against a key the user has trusted. Unsigned packages are allowed but labelled **unsigned**.
5. Show the user: name, author, version, signed or not, the permission list. The user approves. Nothing runs before this.
6. Register: `registry.register({ manifest, load })`, where `load` starts the sandbox (section 3). The package hash goes in the project's `plugins.lock.json`.
   A URL install is a one-time download: the app never re-fetches it by itself, so a plugin cannot change after approval. An update is a new load that the user approves again, and it shows the old and new version.
7. A project that needs a plugin which is not loaded opens with that step marked `step.unknown_plugin`; the UI offers to load the package.

## 3. Sandbox

An external plugin is untrusted code. A Web Worker alone does not stop it using `fetch`, so:

- The host serves a fixed **sandbox page** with a strict Content-Security-Policy (`default-src 'none'; script-src blob:; worker-src blob:; connect-src 'none'`) inside an iframe with `sandbox="allow-scripts"` (no same-origin, so no access to the app's storage or DOM).
- Inside the iframe a worker is created from the plugin's `main.js` (as a Blob URL). It inherits the CSP, so it has no network. The engine's worker protocol (`WorkerHost`, `installWorkerEntry`) runs over a `MessagePort` between the app and that worker.
- Meshes cross as transferred buffers; assets are fetched by the host through `ctx.assets` and sent as bytes. The plugin never sees a URL.
- Budgets (time, triangles) and cancel work as for built-in plugins; a plugin that does not stop is terminated.
- **WebAssembly is allowed** (decided): the sandbox CSP includes `script-src blob: 'wasm-unsafe-eval'`. A `.wasm` file is a normal file in the package (counted in the size caps and in `manifest.sha256`). Wasm does not change the other limits: no network, time budget and terminate still apply, and the memory a worker may use is capped by the browser, not by us, so a plugin that allocates without limit can crash its own worker only. Wasm results go through the same mesh shape check.
- A permission such as `network:<origin>` changes the CSP `connect-src` for that plugin's sandbox only, and only after the user approved it.

Known limits: a plugin can burn CPU until the timeout; it can return wrong or hostile geometry (the host validates the returned mesh: finite numbers, indices in range, within the triangle budget); side channels (timing) are not addressed. Signatures prove who wrote a plugin, not that it is safe.

## 4. Changes to the engine for this

- `WorkerHost` takes a worker factory per plugin id (`create(pluginId)`), so built-in and external plugins can use different workers. Small change.
- A mesh check on every result from an external plugin (`checkMeshShape`), used by the runner when a plugin is marked untrusted.
- A `PluginSource` record in the registry (`builtin` or `package` with hash and signature state) for the UI.
- New code in a new package `@ateliermesh/loader`: unzip, hash and signature checks, sandbox page, the `.amplugin` builder (a CLI that bundles and zips a plugin). It needs a small ZIP library (for example `fflate`): a new dependency, to be approved; the Atelier does not take this package.

## 5. Decisions and open questions

Decided: loading from a URL is allowed (https in production, http in development mode, hash-pinnable, one-time download); WebAssembly is allowed in the sandbox.

Also decided: signing is Ed25519; the user imports the public keys they trust, with no central authority. A catalogue of known plugin URLs comes later, not in M7B; only pasted URLs for now.

Still open:
- Safari support of blob workers and `wasm-unsafe-eval` inside a sandboxed iframe: must be tested in WebKit before we commit (as M0 did for the solver). If it fails, the fallback is a worker served from a separate origin with the same CSP.

## 6. What the build found (2026-11-08)

- **Package format as built:** `manifest.json`, `main.js` (an ES module with a default export `{ run }`), optional `assets/`, `manifest.sha256` (one `<hash>  <path>` line per file) and `manifest.sig` (`{ "alg": "ed25519", "signature": "<base64>" }` over the bytes of `manifest.sha256`). With a listing, every file must be listed and match; a listing that does not match, an unlisted file or a missing file refuses the package. A signature needs the listing, and a signature that no trusted key verifies is **refused**, not shown as "unsigned". The package identity (`hash`) is the SHA-256 of the sorted file listing.
- **The sandbox worker is a classic worker, not a module worker.** In Chromium a module worker created from a blob URL inside a sandboxed iframe (opaque origin) fails to start; a classic blob worker starts, and a dynamic `import()` of the plugin's blob URL from it works in Chromium and WebKit (measured in both, 2026-11-08). So the bootstrap is built as an IIFE and the plugin stays an ES module.
- **WebKit open question closed:** blob worker, dynamic import of a blob module, WebAssembly (`'wasm-unsafe-eval'`) and the CSP all work in WebKit 26.6 (desktop build) inside `sandbox="allow-scripts"`. A real run on a phone was done by hand on 2026-11-16 (reported by the project owner).
- **No relay:** the app creates a `MessageChannel`, sends one end through the iframe to the worker, and talks to it directly with the engine's normal protocol (`installWorkerEntry`), so buffers transfer without copying through the iframe.
- **Measured isolation:** `fetch`, `XMLHttpRequest` and `WebSocket` all fail inside the sandbox; a plugin that loops forever is terminated at the time limit and its iframe removed; a plugin returning NaN positions or out-of-range indices gets `plugin.bad_mesh`; a plugin can read its own files (`pkg:<id>/<path>`) but not `manifest.*`, `main.js` or another package.
- **Permissions:** `manifest.permissions` (for example `network:https://api.example.org`) widens `connect-src` for that plugin's sandbox only; the demo lists them in the approval dialog. There is no UI to grant a permission separately yet: approving the package approves its list.
- **Engine changes:** `PluginEntry.untrusted` and `.source`; `WorkerHost` takes `create(pluginId)`; the runner shape-checks every result of an untrusted plugin.
- **Command line:** `amplugin keygen`, `amplugin pack <dir> [--key]` (compiles `main.ts` with esbuild, packs `assets/`), `amplugin inspect <file> [--trust key.pub]`.
- **Not built:** a catalogue of plugin URLs, key import from a file, revoking or listing trusted keys in the UI, removing a loaded plugin. **Built since (standalone, unreleased):** a project keeps the `https:` address of a plugin; a plugin that is missing on opening is offered: catalog first, then the saved address after a second yes. Open: the package hash in the lock is saved but not yet checked against the file fetched from the address.
