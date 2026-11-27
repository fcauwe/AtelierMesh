# Mirror (the complete example plugin)

The worked example of [`docs/plugin-guide.md`](../../../docs/plugin-guide.md): a `mirror` operation that mirrors a model in place or adds a mirrored copy, keeps segments and groups, reports problems with a code, stops when cancelled, and has tests, fixtures, texts (en, nl, fr) and a package script.

It is **not** part of the repository's test run. To use it, copy this folder somewhere else (it expects `../tarballs/ateliermesh-core-0.1.0.tgz`, made by `npm run pack` in the AtelierMesh repository), then:

```
npm install
npm run typecheck && npm test
mkdir tools && cp <repo>/packages/loader/bin/amplugin.mjs tools/ && npm run pack
```

The smaller example, `examples/plugins/mirror`, is the shortest possible plugin (no tests, no groups).

## Manifest metadata

`manifest.json` has the required `license` and `description`, and an example `contact`. Replace the contact details with your own (or remove `contact`: never invent an address), and add `package_url` (the https address where you publish the packed file) if you want users to be able to check for updates.
