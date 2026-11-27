# Shape fit, plain JavaScript: drawings and stored items

The example for a plugin that works with flat **drawings**. Two operations in one file:

| Operation | Shows |
|---|---|
| `block_from_drawing` | an operation that takes a drawing and returns a mesh: `"payload": { "in": "drawing", "out": "mesh" }` in the manifest, the drawing is `ctx.payload` |
| `fit_to_shape` | a mesh step with a **second input**: a setting `{ "type": "payload", "accept": ["drawing"] }` names a stored drawing, the plugin reads it as `ctx.payloads.shape` |

The engine checks the kind and shape of both before the plugin runs, and the stored drawing is part of what the step computes: change the drawing and only this step and the ones after it run again.

From the plugin kit folder (Node 20 or newer, nothing to install):

```
node tools/amplugin.mjs check examples/plugins/shape-fit-plain
node tools/amplugin.mjs run examples/plugins/shape-fit-plain --op block_from_drawing --input drawing:square:40,20 --params '{"height":4}' --out block.stl
node tools/amplugin.mjs run examples/plugins/shape-fit-plain --op fit_to_shape --input generator:box:10,10,10 --payload shape=drawing:square:40,20 --out fitted.stl
node tools/amplugin.mjs pack examples/plugins/shape-fit-plain --out shape-fit-plain.amplugin
```

`--input drawing:square:w,h` is a rectangle in millimetres; a drawing file (`.amdraw`) works too. `--payload <setting>=<drawing | model>` fills a setting that takes a stored item. In `fixtures.json`, `"input"` may be a drawing, and `"store"` holds the stored items by name; `expect` may say `"payload": { "kind": "drawing", "paths": 1, "bounds": ... }` for a result that is a drawing.
