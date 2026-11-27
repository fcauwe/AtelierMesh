# Name plate (plain JavaScript)

The smallest plugin that asks the host for letter outlines. One file (`main.js`), no imports, no build.

```
node tools/amplugin.mjs check examples/plugins/nameplate-plain --font path/to/any-font.ttf
node tools/amplugin.mjs run   examples/plugins/nameplate-plain --input generator:box --font path/to/any-font.ttf --out plate.stl
```

`--font` gives the dev tool one font file for every font id the plugin asks for; in a real host the ids (`font:Roboto`) are the host's own. The plugin gets polygons, not a font file: see `docs/plugin-guide.md`, "Fonts and text".
