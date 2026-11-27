# 3MF colour: what we write, what we read, and how segment colours reach a slicer

Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.

This page says what `write3mf` puts in a file for those colours, what `read3mf` takes out of one, what a reader or a slicer must support to see them, and where the limits are. The companion page [3mf-parts.md](3mf-parts.md) covers files with several bodies.

Status: written from reading the source of slicers that implement per-triangle paint, plus runs of a command-line slicer on our own test files. The exact attribute and file names a slicer looks for are part of its format, not our choice; they are named constants in `packages/core/src/threemf.ts` (`PAINT_ATTR`, `PAINT_ATTR_ALT`, `PAINT_NS_URI`, `FACETS_FILE`, `OBJECT_CONFIG_FILE`, `CONFIG_VERSION_META`) and are not repeated here. Not verified in a graphical slicer (no GUI was available).

## 1. Two kinds of colour in a file

| What | Where it lives in the file | Who reads it |
|---|---|---|
| A colour (`#rrggbb`) | a standard 3MF colour list (`basematerials`) and, on each triangle or object, the index into it | viewers and any reader of the core specification |
| An extruder number (1 to 16) | a per-triangle paint attribute, a sidecar file next to the model, and/or an object configuration file | slicers that support multi-material painting |

The two are independent. A colour tells a viewer what to draw. An extruder number tells a slicer which filament to use; the slicer shows the colour of that filament, not ours. Slicers that follow the core specification only ignore the standard colours: a file coloured only with them opens as plain geometry.

## 2. What each colour option writes

`write3mf(mesh, { slicer, palette, groupExtruders })`. The standard colours are always written. `slicer` chooses the slicer data on top of them. Default: `inline_sidecar`.

| `slicer` | Per-triangle paint attribute | Sidecar JSON file | Object configuration file (needs `groupExtruders`) | Use when |
|---|---|---|---|---|
| `inline_sidecar` (default) | yes | yes | yes | you do not know the slicer: both forms are written, they do not disturb each other |
| `inline` | yes | no | yes | the slicer reads the attribute only |
| `sidecar` | no | yes | no | the slicer reads the sidecar file only |
| `alt_inline` | the attribute under the other name | no | no | slicers that read paint under the other attribute name |
| `all` | both attribute names | yes | yes | every known form, for a file that goes to any slicer |
| `none` | no | no | no | a viewer, a quote, a web page: standard colours only |

The option values were renamed before anything was released; the bytes written for each option did not change. A test holds the hash of every option (`packages/core/test/threemf-stable.test.ts`).

## 3. Segment colours and extruder numbers

Per segment, the palette says what to write:

```ts
write3mf(mesh, { palette: [
  { segment: 'letters', extruder: 2 },                     // paint: extruder 2; colour: the segment's own colour
  { segment: 'letter_walls', color: '#112233', extruder: 3 },   // an override colour for the file
] })
```

- **Standard colour.** Every segment with a colour (its own, or the palette's `color`) becomes one entry of a colour list named after the segment, and every triangle of that segment points at it. A body that carries a colour (`group.color`) gets an entry named after the body: its triangles that belong to a segment without a colour point at it, and the object itself points at it too. A segment colour wins over the body colour; the default segment `body` can carry a colour too, as the layer below the body colour.
- **Paint.** A segment with an `extruder` gives each of its triangles a paint value. Whole triangles only: extruder 1 is `4`, extruder 2 is `8`, extruders 3 to 16 are one hex digit `n-3` followed by `C` (3 = `0C`, 4 = `1C` ... 16 = `DC`). Uppercase, no separators. An unpainted triangle gets no attribute (never `0`). More than 16 extruders is refused (`export.bad_extruder`).
- **Per-body extruders.** `groupExtruders: { Lid: 1, Base: 2 }` writes an object configuration file with one extruder per body. Only the paint-attribute options (`inline_sidecar`, `inline`, `all`) write it.

| Extruder | Value | Extruder | Value |
|---|---|---|---|
| 1 | `4` | 9 | `6C` |
| 2 | `8` | 10 | `7C` |
| 3 | `0C` | 11 | `8C` |
| 4 | `1C` | 12 | `9C` |
| 5 | `2C` | 13 | `AC` |
| 6 | `3C` | 14 | `BC` |
| 7 | `4C` | 15 | `CC` |
| 8 | `5C` | 16 | `DC` |

### How the string is built (for a reader)

For one triangle the value is a stream of 4-bit nibbles, written as hex digits **in reverse order** (the first nibble of the stream is the last character). The first nibble: bits 0 to 1 are the number of split sides (0 = a whole triangle); for a whole triangle bits 2 to 3 are the state: 0 none, 1 extruder 1, 2 extruder 2, 3 = an extended state, and a second nibble `z` follows: `z` less than 14 means state `z+3`. That is why extruder 3 is `0C` and not `C0`. A triangle the paint tool has split holds several states; the first nibble then counts the split sides and the children follow, last child first. `decodePaint` returns the most frequent non-zero state and `split: true`, and `read3mf` reports the loss as `import.paint_split_triangles`. Test vector for a split: `481` means two children, the first extruder 1 and the second extruder 2.

States above 16 are encoded differently by different slicers. We never write them.

## 4. What `read3mf` takes out of a file

- Geometry, units, components, transforms, objects in other model parts (the production extension). Several root objects become several bodies (`mesh.groups`), named after the object.
- Paint: the inline attribute (either spelling) and the sidecar file give segments `extruder_1`, `extruder_2` ... A split triangle takes its most frequent state and is counted in `splitTriangles`. The segment of an extruder gets that extruder's colour when the file says it: `extruder_colour` in `Metadata/Slic3r_PE.config` (PrusaSlicer, EasyPrint) or `filament_colour` in `Metadata/project_settings.config` (Bambu Studio); a value that is not `#rrggbb` is left out. (Checked with a Spider-Man file from each: red, black, white and blue.)
- Part extruders: Bambu Studio and Creality Print give each part (a component of an object) an extruder in `Metadata/model_settings.config`. When the parts do not all have the same extruder, a triangle with no paint of its own gets the extruder of its part (segment `extruder_N`, coloured from the file's filament colours); paint on a triangle wins. Parts of a single-mesh object (volumes with triangle ranges) are not read this way yet.
- Colours (standard colour lists, and the colour group of the materials extension):
  - one colour for a whole object: the colour of that body (`group.color`); in a single-object file, the colour of the default segment (`segments.table[0].color`);
  - several colours inside one body: a segment `material_1`, `material_2` ... per colour, each with its colour (a file that AtelierMesh wrote is read differently: section 4b);
  - at most 64 distinct colours: with more, the least used are replaced by the nearest of the 64 most used, and the warning `import.colours_reduced` says how many were found;
  - the paint of a triangle wins over its colour (its segment is the extruder);
  - a file without colours reads exactly as before.
- `read3mf` returns `colours`: how many distinct colours the file brought in.

## 4b. Colour slots in a final 3MF

A design with several colours (colour slots, `applyColourMap`) written with `write3mf` or `write3mfCompressed` and read back with `read3mf` keeps its slots, so a host can show the file in a filament per slot without the project.

**What is written.** `applyColourMap(mesh, map, { colours })` makes one segment per slot: the first slot is `body`, the others are `slot_<id>` (the id of the slot in the colour map). The writer gives every segment that has a colour a material named after the segment and points each of its triangles at it:

```xml
<metadata name="Application">AtelierMesh</metadata>
<basematerials id="2"><base name="body" displaycolor="#C0392BFF"/><base name="slot_2" displaycolor="#2980B9FF"/></basematerials>
<triangle v1="0" v2="1" v3="2" pid="2" p1="1"/>   <!-- a triangle of slot 2 -->
```

**What is read.** When the file's `Application` is `AtelierMesh`, `read3mf` gives one segment per material that triangles use, with the material's name and colour. The first slot comes back as `body` (the default segment, with its colour), the others as `slot_<id>`. So the slot of every triangle is in the file, and **two slots with the same colour stay two slots**. Files from other programs are read per colour (section 4): there a material name is free text.

**Rules for a host.**
1. Give **every slot a colour** (the filament it stands for). A slot without a colour has no material in the file, so its triangles come back in the first slot. A slot with no triangles is not in the file.
2. The slot is found by the name: `body` is the first slot, `slot_<id>` the one with that id in the colour map. The map itself is not in the file; a host keeps it (slot names, filaments) with the design. A value that a host wants in the file can go in `write3mf`'s `metadata` (read back from `Read3mfResult.metadata` as `am:<key>`, unescaped).
3. A body's own colour (`group.color`) is still a colour of the body and is never a slot. In a file AtelierMesh wrote, a triangle that has a slot's material is that slot **even when it also carries paint** (our paint is only the slot's extruder number, written by `slicer` or `target`); `paintedTriangles` still counts it. Paint on a triangle with no slot material keeps its own segment (`extruder_N`). So a final 3MF written with `target: 'prusa'` or `'bambu'` gives its slots back by name and colour, like one written with `slicer: 'none'`.
4. The project is the truth and the 3MF a copy. A region that a later step adds, in a design where the project is loaded, is given a slot by the colour map when it is applied (a part no slot names goes to the slot that has `*`, else the first slot); a file does not know that and cannot decide it.

## 4c. A file for one slicer: `target`

`write3mf(mesh, { target: 'prusa' | 'bambu' })` writes what that slicer's own files carry; it replaces `slicer`. Found by trying: EasyPrint (PrusaSlicer's engine) showed one colour for a file with only the paint; the file below made it show both (checked in EasyPrint with an XL 5 tools, 2026-11-18), and the file PrusaSlicer itself writes was the model.

- **`prusa`** (PrusaSlicer, EasyPrint): the paint on each triangle (`slic3rpe:mmu_segmentation`) **and** in `Metadata/Slic3r_facets_annotation.json` (`[{ id, mmSegmentationFacets: [{ triangle, dividing }], mmSegmentationFacetsVersion: 1 }]`); PrusaSlicer 3.0 (read in the source of `version_3.0.0-alpha14`, 2026-11-18) reads the paint only from that file and ignores the attribute, while 2.x ignores the file (**open item: not yet tried in a 3.0 build; 3.0 may still drop `Slic3r_PE.config` and show geometry only**); `slic3rpe:Version3mf` and `slic3rpe:MmPaintingVersion` = 1; `Metadata/Slic3r_PE_model.config` with the model's name (and an extruder only for a body in `groupExtruders`); `Metadata/Slic3r_PE.config` with `extruder_colour` and `filament_colour`, one colour per extruder (extruder 1 is the colour of the default segment, the others come from the palette, a gap is white). No sidecar file. The object is named after `title`: that is the name EasyPrint lists.
- **`bambu`** (Bambu Studio): the paint as `paint_color`; `BambuStudio:3mfVersion` = 1; `Metadata/model_settings.config` (a name, and an extruder for a body in `groupExtruders`); `Metadata/project_settings.config` with `filament_colour`. Modelled on a file Bambu Studio wrote; **not yet opened in Bambu Studio** (open item).
- Without `target` the file is exactly as before (`threemf-stable.test.ts`).

In the Atelier the host sets it: `buildPackage({ ..., target })` passes it on to `write3mf` for `final.3mf`; the customer is never asked, and `slicer: 'none'` (geometry only) wins over it. The standalone's Export dialog offers 3MF for PrusaSlicer and EasyPrint (the default), 3MF for Bambu Studio, 3MF for other slicers (what it wrote until now) and STL.

## 5. What a reader or a slicer must support

- To see our colours: any 3MF reader that follows the core specification (colour list, per-triangle and per-object colour index). Nothing more.
- To use our extruder numbers: a slicer that reads the per-triangle paint (the attribute, or the sidecar file). It needs a printer profile with more than one extruder; with one extruder the paint is ignored. Extruder numbers a printer does not have fall back to its default extruder when slicing.
- The file must open as a plain 3MF in other tools: the standard geometry and colours are complete without the slicer data.
- The package needs `[Content_Types].xml`, `_rels/.rels` and one model part. The slicer data is optional.

## 6. Known limits

- A slicer shows the colour of the filament chosen for an extruder, not the colour in the file. Our colour is for viewers; the extruder number is for the slicer. The user maps extruders to filaments in the slicer.
- Whole-triangle paint only: we never write a split triangle. A colour boundary inside a triangle cannot be written.
- At most 16 extruders. At most 64 imported colours.
- Slicers differ in which of the attribute and the sidecar file they read; `inline_sidecar` and `all` write both so a file works in either. Each reader ignores the form it does not know, so a file with both is correct for either.
- The slicers that read paint differ for states above 16. Not written.
- Lowercase hex digits are not valid paint. We always write uppercase.
- Several slicers ignore the standard colours completely: do not rely on them for the print.

## 7. How this was checked

- Unit tests: the table in section 3, the split example, a round trip of every option, and `threemf-stable.test.ts` (the bytes of every option are fixed by hash).
- Command-line runs of an installed slicer on our own files, headless: files written with each option load and keep their extruders. The graphical views were not opened.
- Not checked: any graphical slicer; behaviour of a printer profile with too few extruders; real files with split triangles of more than one side.
