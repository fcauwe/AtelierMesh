# The Atelier's fonts as 3D text

Measured 2026-11-08 with the engine (`packages/plugins/test/atelier-fonts.test.ts`, which runs every font on a plate and uses the copy of the Atelier's fonts in `assets/atelier`). The list is `Atelier/frontend/src/config/fonts.ts`; the files are in `Atelier/frontend/public/fonts/`. Licences: Google Fonts under OFL or Apache as far as I know; the repository has no licence files, so check before shipping.

All 12 give a closed mesh with "Anna Éloïse" (Bpmf Iansui with "Anna Eloise", see below), raised, at the lightest and heaviest weight of a variable font.

| Font | Type | Weight | Mean stroke at 10 mm letters | Smallest letter height for a 0.6 mm stroke | Characters missing from A–Z, a–z, 0–9, punctuation and Western European accents |
|---|---|---|---|---|---|
| Quicksand (bold) | static | | 1.54 mm | 3.9 mm | Ÿ |
| Cinzel | variable | 400 | 0.66 mm | 9.1 mm | none |
| Cinzel | | 900 | 1.51 mm | 4.0 mm | none |
| Dancing Script | variable | 400 | 0.63 mm | 9.6 mm | none |
| Dancing Script | | 700 | 0.82 mm | 7.3 mm | none |
| Montserrat | variable | 100 | 0.28 mm | 21.5 mm | none |
| Montserrat | | 900 | 2.43 mm | 2.5 mm | none |
| Caveat | variable | 400 | 0.94 mm | 6.4 mm | none |
| Caveat | | 700 | 1.32 mm | 4.5 mm | none |
| Pacifico | static | | 1.37 mm | 4.4 mm | none |
| Over the Rainbow | static | | 0.70 mm | 8.6 mm | none |
| Open Sans | static | | 1.00 mm | 6.0 mm | Ÿ |
| Roboto | static | | 1.11 mm | 5.4 mm | Ÿ |
| Lato | static | | 1.06 mm | 5.7 mm | Ÿ |
| Bpmf Iansui | static | | not measured | | **âãäåæçêëîïñôõöøûýÿœßÂÄÇÊËÎÏÔÖÛŸŒ** (no ï, ë, ç, ô, û: French and Dutch words break) |
| Bonheur Royale | static | | 0.52 mm | 11.6 mm | Ÿ |
| Autery | static | | 0.58 mm | 10.5 mm | everything except A–Z and a–z (no digits, punctuation or accents) |
| Cantarell Extra Bold | static | | 2.1 mm | 2.9 mm | none |
| Chomsky | static | | 1.2 mm | 5.2 mm | € |

- **Mean stroke** is twice the letter area over the outline length, for "Anna Éloïse". It scales with the letter height. The engine warns (`emboss.thin_strokes`) below the step's `min_stroke` (default 0.6 mm, an ordinary 0.4 mm nozzle). Real thin spots (the hairlines of a script font) are thinner than the mean, so use the last column as a floor, not a guarantee.
- **Thin by nature:** Montserrat at weight 100, Bonheur Royale, Over the Rainbow, Cinzel and Dancing Script at their lightest weights. For these the page should limit the size from below or push the weight up.
- **Heavy by nature:** Montserrat 900, Quicksand bold, Cinzel 900. Fine at small sizes.
- **Coverage:** every font except Bpmf Iansui covers Western European text. Bpmf Iansui lacks many accented letters; the engine refuses a text with a missing character and names it (`emboss.missing_glyphs`, `characters: ["ï"]`), so the page can mark the character before the customer presses anything. Suggest hiding this font for Dutch and French, or showing a coverage warning.
- **Variable fonts** (Cinzel, Dancing Script, Montserrat, Caveat) arrive as WOFF2 that fontkit cannot read; the demo build unpacks them to TrueType with `wawoff2` (MIT) when the Atelier checkout is next to it. The Atelier page can ship either the TrueType files or the decompressor.
- **Cache:** parsed fonts are cached by the content of the file, not by the asset id (fixed 2026-11-08 after a test that used one id for twelve fonts).

## Added 2026-11-10 and licences
- The Atelier added **Autery**, **Cantarell Extra Bold** and **Chomsky** and hid **Open Sans** from its pickers (`hidden: true`; still loaded so saved designs keep their look). Figures for the three new fonts are the Atelier's own (its `public/fonts/README.md`, same method); missing characters were checked here with fontkit.
- **Every font comes with its licence file** (`<Name>-license.txt`, from the Atelier's `public/fonts/`). They are mandatory: the SIL OFL asks for the copyright notice and licence text to travel with the font files. The standalone's build copies them to `fonts/atelier/licences/` next to the fonts (and `fonts.json` names each font's licence file); `scripts/make-atelier-fonts.mjs` copies them to `licences/` next to the manifest (`licence` per font). The build warns when a font has no licence file. Do not ship a font without it.
- Autery is not under the OFL: "free for any personal or commercial use" by its author (MasAnis); the licence file holds the author's own wording.

## Added 2026-11-20: Mistral SingleLine and Relief SingleLine
- Two single-line scripts from isdaT (SIL OFL 1.1), the **closed-outline** files (`MistralSingleLineOutline-Regular.woff2`, `ReliefSingleLineOutline-Regular.woff2`). Licence files `Mistral-SingleLine-license.txt` and `Relief-SingleLine-license.txt` travel with them. Added to our copy of the Atelier's list (`assets/atelier/frontend/src/config/fonts.ts`), the font test (now 17 fonts) and `examples/atelier/src/ateliermesh/fonts.manifest.json`. **The Atelier's own `fonts.ts` is not changed: it adds the two lines itself** (`docs/proposals/atelier-handoff-fonts-singleline.md`).
- Each gives a closed mesh with "Anna Éloïse" and has every character of the list (A–Z, a–z, 0–9, punctuation, Western European accents, €, Ÿ, ß).
- **Very thin by nature** (a pen stroke, approximate, measured with fontkit, cap height 10 mm): Mistral about **0.37 mm** (about **17 mm** letters for a 0.6 mm stroke), Relief about **0.62 mm** (about **10 mm** letters). The page should limit the size from below, as for the other thin fonts; the figures are in the manifest as `minLetterHeightMm`.
- **Not used:** the open-path files (`OTF-SVG`, Relief's `CAD.ttf`) are skeleton lines for CNC and Adobe: Relief CAD failed in the engine (`emboss.touches_patch_edge`, `emboss.invalid_result`). Mistral SingleLine is a monolinear version of Roger Excoffon's Mistral (1953); the commercial Mistral typeface is a different product.
- **OPEN:** the figures are from the same method as the 2026-11-08 table but not run through `atelier-fonts.test.ts` weights; check the look of a printed sample before the shop offers them.

