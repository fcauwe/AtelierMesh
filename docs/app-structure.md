# AtelierMesh: journeys, screens and structure (v3, 2026-11-08)

v1 of this page assumed the wrong journeys. This version follows what you described and what the Atelier code does (`frontend/src/router.tsx`, `pages/Landing|Upload|Upload3D|Editor|Preview.tsx`, `documentation/specs/Atelier_user_journeys.md` J1, J3, J9, `proposals/atelier-3d-print-vision.md`).

## 1. What the Atelier code shows today

- **Landing** has a switch laser cut / 3D print. "Upload" goes to `/upload` (cut) or `/upload-3d` (3D).
- **`/upload`** takes SVG, DXF, bitmap (trace dialog), then a scale dialog, then `/editor`. **`/upload-3d` is a "coming soon" stub** (an illustration, a text, a back button). J9 and the vision doc say the 3D upload will take STL or 3MF, with a units step for STL only (a 3MF declares its unit).
- **`/editor`** is the maker's page: shapes, operations, material, then **Preview**.
- **`/preview`** is the page both journeys meet in. It shows the part (view switcher Preview / 3D / Machining file), the material, producer, then **Calculate price**. When the design is flagged `personalisable`, a pill button with a **pen icon and the label "Personalise"** sits on the picture (a tick when something was changed).
- **Personalise** opens a **full-screen overlay**: title, **Reset** and **Done** in the top bar, the editing canvas below. **Done** closes it and returns to the Preview with the personalised result and the tick. Reset goes back to the designer's version. This is the "SVG edit flow" the customer journey must copy.
- Catalogue designs and products carry a `personalisable` flag (`part_designs`, `products`) and show an indigo "Personalisable" badge on cards (`Landing`, `Products`).
- Price, material, producer, quote and checkout belong to the Atelier. AtelierMesh never sees them.

## 2. The three journeys

### A. Standalone AtelierMesh (no quote)
Upload a mesh (STL, 3MF, or a saved configuration) → units step for STL → **editor** with all functionality (steps, plugins, apply permanently, undo) → **export** (3MF by default, STL) → or **save the configuration** and **reopen it later**. No roles, no price, no material.

Saving and reopening, two ways, same content:
- **A file**: `.amproj` (decided). It contains the mesh (as a native binary mesh, not the original STL), the step list, the apply marker, the assets (fonts, SVGs by hash) and the plugin lock.
- **The browser's memory** (IndexedDB): "Save in browser" and a "Browser projects" list (open, delete, replace on save). Built in the standalone app (`apps/standalone/src/library.ts`, with a journey test in Chromium and WebKit). It holds the same `.amproj` bytes, stays in this browser only, and the dialog says so. Open question: autosave (see 8).

### B. Designer (in the Atelier)
`/upload-3d` (the stub becomes the real upload page) → units step → **3D editor page** (the same editor as A, plus the Atelier's material, precision, infill) → the designer builds steps, **marks a step, or only some of its fields, as personalisable** and sets the limits (move at most, direction range, size range) → **Preview** → the design is saved as a personalisable design in the catalogue.

### C. Customer (in the Atelier)
Catalogue / landing: clicks a design card (with the Personalisable badge) → **Preview** with the designer's result → clicks the **Personalise (pen) button** → **full-screen personalise overlay**: a small panel of exactly the fields the designer opened (text, font, size, ...), the 3D result updating live, **Reset** and **Done** → **Done** → back in the **Preview** with the tick and the personalised model → Calculate price → quote.

The customer never sees a step list, plugins or projects, and **does not click on the model to place the text**: the designer already placed it. The customer can only move it if the designer opened "position" and within the limits set.

## 3. One engine, three surfaces

| Surface | Used in | What it is | Who builds it |
|---|---|---|---|
| **Full editor** | A, B | step list, 3D view, parameter panel, limits, personalisable marks, apply permanently, plugins, undo, export/save | AtelierMesh; in B the Atelier adds its settings column (material, precision, infill, price) beside it |
| **Personalise overlay** | C | reduced editor: only customer-editable fields + live 3D, Reset, Done | AtelierMesh component, hosted by the Atelier's Preview |
| **Preview (3D view)** | B, C | read-only 3D of the result, with price, material, producer | the Atelier already (View3D); AtelierMesh supplies the mesh and the viewer |

The design handoff covered the overlay, but drew it as a side panel with "Save to quote". That is wrong for the Atelier: there is no Save to quote in the overlay; it ends with **Done**, and the Preview owns price and quote.

### The boundary: AtelierMesh knows no materials

Decided: AtelierMesh does not know materials, prices, precision, infill or producers. The Atelier owns them (functional spec EDT-058, EDT-060, MAT-*, PRC-*: the editor's settings are precision, material, infill; the price comes from the server after each change).

What the Atelier spec says about the 3D editor page (EDT-056 to EDT-062), and what follows:

| Spec | Consequence for AtelierMesh |
|---|---|
| EDT-056 layout: viewport in the middle, **operation list left, settings right** | AtelierMesh supplies the **operation list (step list)** and the **viewport**, and the parameter panel of the selected step (placed under the list, or as a section of the right column; the Atelier decides). The right column's precision, material, infill and price are the Atelier's. |
| EDT-058, 060 settings and price | not ours. The host may call the engine for a mesh, but never passes material to it. |
| EDT-061 original file kept; operations re-applied when the part is opened | matches our step list on top of an untouched base mesh. |
| EDT-062 flag `personalisable` **per operation** | our engine can mark **fields** inside a step. The Atelier stores the flag per operation; we need to agree whether it is the step's switch, the field list, or both (see 8). |
| ORD-149 (V1) no personalisation button for `fdm` | this journey (C) is the V3 of the Atelier's phasing; it needs a spec change on their side. |
| IMP-052 a 3MF with more than one mesh is refused, colours/materials in a 3MF are ignored | the Atelier's import is stricter than ours (we read multi-body and colour). The Atelier side wins when embedded. |

In AtelierMesh code the word appears only as (a) the opaque `material?: number` slot on a mesh group, which the host may fill, and (b) the 3MF colour entries we write for a second part. The viewer shows the part in a neutral colour; the host may call `setColor()` with the material colour it chose. The engine never reads or writes a material choice.

## 4. Screen map (revised)

| # | Screen | Journey | Status | Notes |
|---|---|---|---|---|
| 1 | **Upload page** (STL, 3MF, saved configuration; choose a sample) | A, B | built in the demo (plain), Atelier page is a stub | mirrors `/upload`: file control, onboarding once, recent items |
| 2 | **Units step** (STL: mm or inch) and size confirmation, like the SVG scale dialog | A, B | missing | 3MF skips it |
| 3 | **Load checks** (too many triangles, not a closed solid, simplify offer) | A, B | codes exist, screen missing | |
| 4 | **Editor page** (steps, view, panel, status line, undo/redo) | A, B | built (plain), not designed | the designer's main screen |
| 5 | **Personalisable marks and limits** (per step and per field) | B | built in the demo, not designed | where in the step: a "customer may change" switch per field |
| 6 | Apply permanently, plugin manager, fonts, project dialogs | A, B | designed (specs), built | |
| 7 | **Export** (3MF default, STL) and **Save configuration / Open** (file and browser memory) | A | built (file and browser), partly designed | browser list is a dialog |
| 8 | Preview with the pen button | B, C | the Atelier's, needs the 3D version | AtelierMesh provides the 3D view only |
| 9 | **Personalise overlay** (panel + live 3D + Reset + Done) | C | partly designed as a side panel, needs redrawing | |
| 10 | Waiting (loader, stage, Stop), problems (banner with a way out) | all | designed | inside 4 and 9 |
| 11 | Cannot run here (no WebGL, old browser, out of memory, a worker crashed) | all | missing | |
| 12 | Server refused the step list | C (at quote) | the Atelier's error page | wording from engine codes |

Not ours: landing, catalogue, price, quote, cart, account.

## 5. Layouts

Editor page (A, B), desktop. Layout follows the Atelier spec (EDT-056): operations left, viewport middle, settings right.

```
+----------------------------------------------------------------------------+
| Atelier navbar (B) / AtelierMesh header (A)                                |
+--------------+--------------------------------------------+----------------+
| Steps        |                                            | B only, the    |
|  1 resize    |             3D view                        | Atelier's:     |
|  2 rotate    |             ghost, handle, arrow           |  material      |
|  3 text  *   |                                            |  precision     |
|  [+ add]     |   [3D Front Top Side]   loader / stage     |  infill        |
|--------------|                                            |  price         |
| Step settings|                                            |                |
| (generated   |                                            | A: this column |
|  panel, with |                                            | is absent, the |
|  "customer   |                                            | view is wider  |
|  may change" |                                            |                |
|  and limits) |                                            |                |
+--------------+--------------------------------------------+----------------+
| status: closed solid | 52 x 30 x 8 mm | undo redo | Export 3MF (A) | Preview (B)   |
+----------------------------------------------------------------------------+
```

Personalise overlay (C), full screen, copied from the SVG overlay:

```
+----------------------------------------------------------------------------+
| Personalisable                                         [Reset]  [Done]     |
+------------------------------------------------------+---------------------+
|                                                      | Text   [ Anna     ] |
|                    3D view                           | Font   [ 12 fonts ] |
|                    live result                       | Size   -----o--  mm |
|                                                      | (move: 4 arrows,    |
|                                                      |  only if opened)    |
+------------------------------------------------------+---------------------+
```
Phone: the panel is a bottom sheet pulled down to a bar; Done stays in the top bar.

## 6. What this changes

1. **Customer entry is the Preview, not a page of its own.** No Start, Review or Save-to-quote screens from us.
2. **No click-to-place for the customer.** Placing is the designer's act on the editor page. This also removes the "model view for the customer picks a point" prototype step; the prototype's nudge arrows, text, font, size and direction stay.
3. **Units step replaces my "model check"** (the Atelier already specified it that way). The load checks are shown on that step.
4. **Standalone is a real app** with an upload page and export. The demo is already close; it needs the design, not new engine work.
5. **Personalisable marks per field** become a first-class part of the editor design (screen 5). The engine already stores which fields are customer-editable and clamps them.
6. **Embedded contract is small:** the Atelier gives the overlay a step list, language and the font files; the overlay returns the changed step list on Done (and a Reset to the designer's version). No header, no save button.

## 7. What design should do next
- Redraw the customer surface as the **overlay** (screen 9) in the Atelier's SVG-overlay style, with Reset and Done, desktop and phone.
- Draw the **editor page** (screens 4 and 5), the missing screen set.
- Draw **upload + units + load checks** (1 to 3) in the style of `/upload` and its scale dialog.
- Keep the waiting, problem and dialog work from handoff v2 (inside screens 4 and 9).

## 8. Decisions (2026-11-08) and what is built

| Decision | Built |
|---|---|
| Personalisable is **per field**; a step is personalisable exactly when it hands over at least one field | core `setPersonalisableParams` / `stepPersonalisable`; `makeStep` derives the flag; the demo has one tick per field, no step-level switch |
| A **preview** of the customer view for the designer | demo "Preview as customer": full-screen overlay with Reset and Done, only the opened steps and fields, the designer's limits applied. Done returns to the designer's version and says how many fields were changed |
| **Autosave** in the browser after the first manual save | demo: every 2 s when something changed; "Saved in this browser at HH:MM" |
| Build the customer overlay in AtelierMesh first; the Atelier's spec change (V3 personalisation, EDT-062 per operation) follows later | yes |
| Material, price, precision, infill belong to the Atelier | nothing of them in AtelierMesh |
| `.amproj` is the configuration file and includes the mesh | yes |

Note for the Atelier spec change: EDT-062 flags a whole operation; our model is the list of fields (`personalisable_params`), the operation flag follows from it.

Still open: nothing blocking. Next is design of the editor page, the upload and units pages, and the overlay (section 7).

## 9. Decisions after design handoff v3 (2026-11-08)

- **Name:** the word is **personalisable**, never "customer may change". A tick says "Personalisable"; a step with a ticked field is personalisable. (The stored names `personalisable_params`, `personalisable` and `personalisable_limits` are unchanged for now, because the Atelier's documents use `personalisable`; renaming them is a mechanical change we can make together with the Atelier.)
- **Parts of a placement:** the designer can make **position** and **direction** personalisable separately. Stored as `placement.position` and `placement.direction` in `personalisable_params`; `placement` alone means both. The validator holds the customer to whichever parts are open and to the designer's limits.
- **Limits on typed text:** `max_lines` and `max_line_length`, set by the designer per text field (`personalisable_limits`), enforced by the validator and by the panel (typing stops at the limit).
- **No clutter for normal users:**
  - **Standalone app:** all personalisation tools (ticks, limits, Preview as customer, the customer role) are hidden. **Settings > "Show the Personalised design option"** makes the switch appear (remembered).
  - **Designer in the Atelier:** the switch **"Personalised design"** is always in the designer view. It is a **per-design toggle**: off hides every personalisation tool; on shows them. Switching it off removes what was marked, after asking. Opening a design that already has personalisable steps switches it on.
  - In the demo, `?atelier=1` imitates the Atelier's designer view.


## Where the screens are built (2026-11-09)

One set of screens in `@ateliermesh/react`, used by both hosts. Standalone (journey A): `apps/standalone` (upload page, units step, load checks, editor, export and save dialogs, saved configurations, settings, plugin manager, cannot-run). The Atelier (journeys B and C) mounts the same `UploadPage`, `UnitsDialog`, `LoadCheckDialog`, `EditorPage` (mode `designer`, its own column in `aside`) and `PersonaliseOverlay`. (The old plain-DOM `apps/demo` was removed on 2026-11-16.)
