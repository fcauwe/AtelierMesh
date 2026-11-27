# Fonts in this repository

| Font | Where | Licence | Note |
|---|---|---|---|
| Manrope (variable, latin and latin-ext) | `apps/standalone/public/fonts/manrope-*.woff2` | SIL Open Font License 1.1 (Mikhail Sharanda, https://github.com/sharanda/manrope) | The font of the micro-fabriek design system. Downloaded from Google Fonts (v23) and served from the app itself, so the page makes no request to another server. |
| The Atelier's twelve fonts for text (Roboto, Lato, Open Sans, Quicksand, Montserrat, Cinzel, Dancing Script, Caveat, Pacifico, Over the Rainbow, Bonheur Royale, Bpmf Iansui) | `assets/atelier/frontend/public/fonts/` with the list in `assets/atelier/frontend/src/config/fonts.ts` | Each font has its own licence; the Atelier chose them from Google Fonts, where they are open licences (SIL OFL 1.1 or Apache 2.0). **To be confirmed by the owner before the files are published with a release** (the Atelier plan lists the same open point). | A copy of the Atelier's `frontend/public/fonts` and `src/config/fonts.ts`, so the demo, the standalone and the tests build without the Atelier checkout. Update by copying the files again when the Atelier changes its list. |

The licence texts of the Open Font License and of the Apache License 2.0 are available at https://openfontlicense.org and https://www.apache.org/licenses/LICENSE-2.0.

The Atelier's fonts (copied from the Atelier's `public/fonts/`, with their licence files, into `assets/atelier/frontend/public/fonts/`): each font's licence is the `<Name>-license.txt` next to it. See `docs/fonts.md`, "Added 2026-11-10 and licences".
