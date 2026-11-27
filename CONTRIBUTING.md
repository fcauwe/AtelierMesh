# Contributing to AtelierMesh

Thank you for looking. Two things first.

**Pull requests.** AtelierMesh is dual licensed (AGPL-3.0-or-later, and other licences on request: see `LICENSING.md`). To keep that possible, a contribution can only be accepted when its author agrees that it may be used under the AGPL **and** under the other licences we grant. A short contributor agreement will be added; until then please **open an issue** instead of a pull request, and describe what you want to change and why. We will say how to go on.

**Plugins.** You do not need our permission, or a pull request, to make a plugin: write it with the plugin kit (`docs/plugin-guide.md`), give it any licence you like, and share it by its file or address. If you think it belongs in the catalogue of micro-fabriek.be, send it there (or ask in an issue).

## Reporting a problem

An issue helps most when it says: what you did, what you expected, what happened, the version (Settings, About in the app) and the browser. A small model file or a project file (`.amproj`) that shows the problem is the best thing you can attach, if you may share it.

## Working on the code

You need Node 24 or newer.

```
npm install
npm run check        # typecheck, lint and all tests
```

- Code is TypeScript; the packages stay small and dependency-free where they can.
- A change comes with a test; browser tests live next to the screens they test.
- A package whose content changes gets a new version (all packages move together); see `CHANGELOG.md`.
- User-visible texts go in the locale files (English, Dutch, French), never in the code only.
- UK English in documents and texts.
