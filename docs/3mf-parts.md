# 3MF with several parts: bodies, extruders, colours

Every part of a mesh, a segment (a coloured region) or a group (a body), can carry a colour (#rrggbb). The mesh itself has no textures, UV coordinates or per-vertex colours: colour lives on parts. A plugin may keep the colours it gets, give new parts a colour, or colour its output by a rule (height, face direction ...). Colours appear in the 3D view and in a 3MF export.

Companion to [3mf-colour.md](3mf-colour.md) (per-triangle colour and paint). This page is about files that hold more than one body: how a slicer sees them, what makes parts show different colours, and what `write3mf` writes.

Marking: OBSERVED = seen in the output of a command-line slicer run by us on our own test files; FROM SOURCE = read in the slicer's code, not run; UNVERIFIED = neither. The graphical views were not opened. Exact file and attribute names are named constants in `packages/core/src/threemf.ts` and are not repeated here.

## 1. What makes parts show different colours

1. A slicer colours each part by its extruder number, not by object, material or a colour in the file. The colour comes from the filament of that extruder in the user's printer profile.
2. A part's extruder is the one set on its volume, else the one set on its object, else none (the default extruder). FROM SOURCE.
3. A plain 3MF, with no slicer data, carries no extruder, so every part gets the default one. OBSERVED.
4. Some slicers offer, when a file with several touching objects opens, to merge them into one multi-part object and then give part 1, 2, 3 ... extruder 1, 2, 3 ..., wrapping at the number of extruders of the printer. With a one-extruder printer every part gets extruder 1. FROM SOURCE. This is why files "open in different colours" for some users and not for others.
5. So seeing several colours depends on the printer profile having more than one extruder and more than one filament colour.

## 2. How a slicer sees several bodies

| In the file | Read as |
|---|---|
| Several objects, one build item each | separate objects, one part each. OBSERVED in every slicer we ran |
| One object with components | depends on the slicer: separate objects in some, one object with several parts in others. OBSERVED |
| One merged mesh plus an object configuration file with a volume (triangle range) per part | one object with several parts, each part carrying its extruder. OBSERVED |
| The production extension (objects in other model parts) | read and followed by the slicers we ran. The extruder or colour data of other vendors' project files is not read. OBSERVED |
| The standard colour list, `pid`/`p1`, object `pid`/`pindex` | ignored by the slicers we ran, no colour and no extruder comes from them. OBSERVED and FROM SOURCE |

## 3. What `write3mf` writes for bodies

- One `<object>` per group (`mesh.groups`), named after the group, plus one build item each. A group with a colour gets a colour-list entry named after it and the object points at it; see [3mf-colour.md](3mf-colour.md) section 3.
- `groupExtruders: { Lid: 1, Base: 2 }` (keyed by group name) adds an object configuration file: one object per body, with its extruder on the object and on its one volume (the triangles of that object). Written with `inline_sidecar`, `inline` and `all`; the model part then also carries the marker that tells the slicer the file has that configuration. Without the marker a slicer treats the file as foreign and bakes instance transforms into the mesh, which is harmless.
- Separate objects with per-body extruders are the form that works across the slicers we ran: the bodies open as separate objects, each on its extruder.
- The sidecar-only form (`sidecar`) writes paint but no per-body extruders: one slicer's project-file form for them failed at random in its command line, so we do not write it.

## 4. What `read3mf` does with several bodies

Several root objects become several groups named after the objects ("Part N" without a name, numbers added to repeat names). Colours per object become group colours ([3mf-colour.md](3mf-colour.md) section 4). The object configuration file's volumes, volume names and extruders are not read yet. OPEN.

## 5. Recommendation

- For a print in several colours, write separate objects with `groupExtruders` and paint for the segments, with the default option. Tell the user to map extruders to filaments in the slicer.
- Do not rely on colours for the print; they are for viewers.
- For two parts that touch, expect some slicers to ask whether to merge them into one object; the answer decides whether the parts get different extruders automatically.

## 6. Unverified

- Everything graphical: the merge dialog, the colours in the 3D view, what the user sees for extruders beyond the printer's count.
- Behaviour of released versions newer than the ones run (a slicer's next major version was only run as an alpha, and its project-file form was unreliable in its command line).
- Other vendors' slicers for any of these files.
