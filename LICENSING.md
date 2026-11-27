# Licensing

AtelierMesh is **dual licensed**.

## 1. By default: GNU Affero General Public License, version 3 or later

Unless you have agreed something else with us in writing, you may use, study, change and share AtelierMesh under the terms of the **GNU AGPL-3.0-or-later**. The full text is in [`LICENSE`](LICENSE).

In short: if you run a changed version of AtelierMesh so that other people use it over a network (a web shop, a service, an app in the browser), you must offer those people the source code of your version under the same licence. A copy of the code that you only use yourself, or that you share with its source, is fine.

This applies to everything in this repository that we wrote: the engine (`packages/core`), the built-in plugins (`packages/plugins`), the interface (`packages/ui`, `packages/react`), the loader (`packages/loader`), the standalone app (`apps/standalone`), the demo, the catalog server scripts and the documentation. Every built-in plugin says so in its manifest (`"license": "AGPL-3.0-or-later"`).

## 2. Other licences, on request

If the AGPL does not fit (for example you want to build AtelierMesh into a closed product or a service without publishing your source), you can ask for **another licence**. Terms are agreed per case. Contact: https://micro-fabriek.be

## Additional permission for plugins (AGPL section 7)

As an additional permission under section 7 of the GNU AGPL version 3, you may copy the **Plugin Interface** of AtelierMesh into a plugin, bundle it into the plugin's package, and distribute that plugin under any licence you choose, as long as you keep the copyright notices of the parts you copy. The Plugin Interface is: the type declarations of `@ateliermesh/core`, `MeshError`, and the helpers of `@ateliermesh/core` and `@ateliermesh/core/testing` that `docs/plugin-guide.md` names as available to plugins. If you change those parts themselves, the changed parts stay under the AGPL. The rest of AtelierMesh (the engine, the built-in plugins, the interface and the apps) is not covered by this permission.

## What is not covered

- **Plugins made by other people** (`.amplugin` packages, or code in your own repository), including ones built with the kit, keep the licence their maker chose; each package states it in its manifest. Loading a plugin in the browser sandbox does not by itself make it part of AtelierMesh.
- **The plugin kit** (docs, templates, the Mirror example, the type declarations, the `amplugin` packing tool in `packages/loader`) is under the **MIT licence** (`LICENSE-KIT`, also inside the kit zip), so a plugin made with it can have any licence.
- **Icons:** the drawing data of some icons in `packages/react/src/icons.tsx` comes from [lucide](https://lucide.dev) (ISC licence, copyright the Lucide Contributors, and for the parts derived from Feather, Cole Bemis). The ISC licence allows use, copying and distribution with this notice kept.
- **Third-party code and fonts** keep their own licences. `npm run licenses` lists the runtime dependencies of the packages; the fonts and their licences are listed with the fonts (`apps/standalone/public/fonts/README.txt`).

## Contributions

To keep dual licensing possible, a contribution is accepted only when its author agrees that it may be used under the AGPL **and** under the other licences we grant. (A short contributor agreement will be added before outside contributions are taken; until then, open an issue instead of a pull request.)
