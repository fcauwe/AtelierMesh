# AtelierMesh documentation

| Document | For whom | What it holds |
|---|---|---|
| [`../SPEC.md`](../SPEC.md) | everyone | The standard: concepts, manifest, mesh type, operation catalogue, project file, security. |
| [`plugin-framework-explained.html`](https://ateliermesh.app/how-plugins-work.html) | everyone | Pictures of how the plugin framework works: steps, what is inside a plugin, how a step runs in the worker, the three ways to load a plugin. |
| [`plugin-guide.md`](plugin-guide.md) | plugin authors | **Start here to build a plugin**: what a plugin can do, the ten-minute path, the manifest and run contract, parts, texts, personalisation, tests, packaging, a worked example and troubleshooting. |
| [`prompt-make-a-plugin.md`](prompt-make-a-plugin.md) | plugin authors | A prompt (full and quick) to give to your coding agent so it builds a plugin for you, with rules, deliverables and acceptance checks. |
| [`plugin-authoring.md`](plugin-authoring.md) | plugin authors | The exact interfaces a plugin implements and what a host gives it. Matches `packages/core`. |
| [`plugin-tutorial.md`](plugin-tutorial.md) | plugin authors | Write, pack, sign, load and check a plugin in ten minutes (example in `examples/plugins/mirror`). |
| [`NO-NPM.md`](NO-NPM.md), [`CONTRACT-CHEATSHEET.md`](CONTRACT-CHEATSHEET.md) | plugin authors | Making a plugin with only Node, only Python, or only a shell and an editor. |
| [`payload-kinds.md`](payload-kinds.md) | plugin authors, host developers | Meshes and drawings in one workflow: payload kinds, what the runner checks, the drawing type, projects with a drawing base. |
| [`external-plugins.md`](external-plugins.md) | host builders | How the standalone app loads plugins it was not built with: package format, verification, sandbox, permissions. |
| [`headless.md`](headless.md) | everyone | Run a recipe on a model without a browser (`ateliermesh recipe.amrecipe model.stl result.3mf`). |
| [`app-structure.md`](app-structure.md) | host developers | How the standalone app is put together from the shared screens. |
| [`3mf-colour.md`](3mf-colour.md), [`3mf-parts.md`](3mf-parts.md) | developers | How colours and parts are written into a 3MF so PrusaSlicer and Bambu Studio read them. |
| [`fonts.md`](fonts.md) | developers | Fonts as 3D text: stroke width, smallest size, missing characters. |
| [`design-texts-loading.md`](design-texts-loading.md) | developers | The texts of the loading page, in English, Dutch and French. |
| [`../INTEGRATION.md`](../INTEGRATION.md) | host developers | How a web shop or app adopts the packages: install from tarballs, the smallest setup, the server-side checks. |
| [`proposals/project-store-plan.md`](proposals/project-store-plan.md), [`proposals/colour-slots-plan.md`](proposals/colour-slots-plan.md), [`proposals/enum-choice-pictures.md`](proposals/enum-choice-pictures.md) | developers | Working notes that explain why the project store, the colour slots and the picture choices are the way they are. |
| [`../CHANGELOG.md`](../CHANGELOG.md) | everyone | What changed, and the deprecation policy. |
| [`../LICENSING.md`](../LICENSING.md) | everyone | The licences: AGPL by default, other licences on request, the plugin exception and the MIT plugin kit. |

Where the documents disagree, `packages/core/src` and its tests are the truth for what is built; `SPEC.md` is the truth for what is intended. A difference is a bug in one of them.
