# Mirror, plain JavaScript (no npm, no build)

The same plugin as `../mirror-full`, written as one JavaScript file you can read in a minute. Use it as the template when you have no npm.

| File | What it is |
|---|---|
| `manifest.json` | the plugin's id, its operation and every setting with limits, units and conditions |
| `main.js` | the plugin: ONE ES module, no imports. `export default { async run(op, ctx) { ... } }` |
| `fixtures.json` | checks with expected sizes, volumes and error codes (the same expectations the engine's conformance fixtures use) |
| `locales/en.json`, `nl.json`, `fr.json` | the plugin's texts |

From the plugin kit folder (Node 20 or newer, nothing to install):

```
node tools/amplugin.mjs check examples/plugins/mirror-plain
node tools/amplugin.mjs run examples/plugins/mirror-plain --input generator:box:10,20,30 --params '{"axis":"x","mode":"copy","gap":2}' --out result.stl
node tools/amplugin.mjs pack examples/plugins/mirror-plain --out mirror-plain.amplugin
node tools/amplugin.mjs inspect mirror-plain.amplugin
```

To start your own: `node tools/amplugin.mjs new my-plugin` writes a smaller template, or copy this folder and change the id in `manifest.json`.

## Manifest metadata

`manifest.json` has the required `license` and `description`, and an example `contact`. Replace the contact details with your own (or remove `contact`: never invent an address), and add `package_url` (the https address where you publish the packed file) if you want users to be able to check for updates.
