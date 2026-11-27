# Prompt: have your coding agent build an AtelierMesh plugin

Copy the **full prompt** (or the **quick prompt** at the end) into your coding agent, fill in every `{{placeholder}}`, and send it. The agent should ask you the questions in section "Before you start" first. The guide it follows is [`plugin-guide.md`](plugin-guide.md); a worked example is in `examples/plugins/mirror-full`.

**No npm** (no network, no package installs: only Node, or only Python 3, or only a shell and an editor)? Use **the full prompt without npm** or **the quick prompt without npm** at the end of this file. They send the agent to `docs/NO-NPM.md`, plain JavaScript and the kit's tools.

Two situations, same prompt:

| | You work **outside** this repository | You work **inside** this repository |
|---|---|---|
| What you have | **The plugin kit** (unzipped): `README-START-HERE.md`, `docs/`, `spec/SPEC-plugins.md`, `examples/plugins/mirror-full`, `packages/*.tgz`, `types/`, `tools/amplugin.mjs`. Nothing is on npm; the npm package called `amplugin` is not ours | The repository |
| Where the plugin lives | Inside the kit, next to the example: copy `examples/plugins/mirror-full` to `examples/plugins/{{name}}` (same folder depth) and change it | `packages/plugins/src/{{name}}-plugin.ts` and `{{name}}-run.ts` (a built-in plugin), or a folder like `examples/plugins/{{name}}` (an external package) |
| Verify with | in the plugin folder: `npm install`, `npm run typecheck`, `npm test`, `npm run pack`, `npm run inspect` | `npm run check`, `npm run check:packages`, plus the commands on the left for an external package |
| Texts go to | The `locales/` folder of your plugin; the host reads it from the package and merges only keys `ops.<your operation id>.…`, `step.op.<your operation id>` and `mesh.<your operation id or last part of your plugin id>.…` | `apps/standalone/src/locales/{en,nl,fr}.json` and `docs/design-texts-{{name}}.md` |

---

## The full prompt

```text
You are going to build a plugin for AtelierMesh: a set of JavaScript/TypeScript packages in which a plugin
turns a 3D mesh into another mesh (a "step"), and a host (a standalone app, or a web shop) draws its settings
from a manifest and runs it. You write no user interface.

## The plugin I want
- Name and id: {{plugin name}} / {{reverse-domain id, lower case, for example com.mycompany.bevel}}
- What it does, in plain words: {{what it does, for whom, and why a person would add it as a step}}
- Operation(s), each with: {{operation id and title}}, kind {{generator | modifier | analyzer}},
  category {{prepare | shape | surface | check | another lowercase id}}
- Settings the person can change (name, type, default, limits, unit, when it is shown):
  {{list the parameters, for example: "depth, number, 0.5 mm, 0.1 to 5 mm" and "mode, choice of flat or round"}}
- Settings a designer may hand to a customer to change in a shop (personalisable), with their limits:
  {{none | list; remember: only hand over what is safe to change freely}}
- Keep parts: {{does it work on one part (a segment or a body) | does it add a coloured part (a segment name) | none}}
- Input and expected result, as an example I can check: {{a small example, for example "a 20 mm cube, depth 1 mm gives
  a cube with 1 mm bevelled edges, volume about X, still a closed solid"}}
- Performance: {{for example "under 2 seconds for 100 000 triangles on a laptop", or "interactive: a slider drags it live"}}
- Allowed dependencies: {{none | list}}. Any dependency must have a permissive licence (MIT, BSD, ISC, Apache-2.0);
  report its licence. No dependency may use the network.

## Read first, in this order
0. README-START-HERE.md               (only with the plugin kit: what is in it and the exact commands)
1. docs/plugin-guide.md                 (the whole path, with a worked example; follow it)
2. docs/plugin-authoring.md             (exact interfaces; the section "How it looks" lists presentation hints)
3. SPEC.md, sections 4 to 6 and 8       (manifest, mesh, segments and groups, runtime contract, security;
                                        in the kit it is spec/SPEC-plugins.md)
4. examples/plugins/mirror-full         (a complete plugin with tests, fixtures and texts: copy its structure)
5. docs/external-plugins.md             (packages, sandbox, signing)
Outside the repository you have the plugin kit: these files, the packed packages in packages/, the type
declarations in types/ and the packing tool tools/amplugin.mjs. Never install the npm package named `amplugin`:
it is not ours. Inside the repository, also look at the built-in
plugins in packages/plugins/src (repair, deform, low poly and Voronoi are good models) and their tests.

## Hard rules
- Millimetres, Z up, triangles counter-clockwise seen from outside. A printable result must be a closed solid
  if the input was one. A positive volume proves the winding is outward.
- Never change the input mesh. Return new arrays.
- Deterministic: no Math.random, no Date, no network, no state kept between runs, no eval. Need randomness? Take a
  `seed` parameter and use your own small generator. Same input, same output.
- Stop when cancelled: check ctx.signal.aborted in loops and throw new MeshError('run.cancelled').
- Letters: never parse a font yourself. Put "uses": ["fonts"] in the manifest, take the font as an asset parameter (widget "font", accept ["font"]) and call `await ctx.fonts.outline(fontId, text, { size })`: polygons in mm (y up, outer contours counter-clockwise, holes clockwise). See docs/plugin-guide.md, "Fonts and text", and examples/plugins/nameplate-plain.
- Problems are structured: throw new MeshError('{{prefix}}.something', { numbers a person needs }), never only a
  sentence. Use warnings (the `warnings` array of the result: shown as a warning, never blocks) for a usable result that needs a look. Nothing that is not a MeshError may escape run():
  it counts as a crash and the engine switches the plugin off.
- Keep segments and groups through your operation; carry labels from old triangles to new ones; groups are
  contiguous triangle ranges that cover the whole mesh. Declare the parts you make in outputs.
- Colour lives on parts; keep them. Every segment and every group can carry a colour (#rrggbb); keep the colours of the parts you keep, and give a part you make a colour if it should show one (only #rrggbb is accepted).
- AtelierMesh knows nothing about materials, filaments, prices, precision or infill. Do not add any.
- Hard limits (min, max) in the manifest are real limits, enforced again on a server.
- Texts for people: UK English, short, say what happened and what to do, with the numbers. Provide en, nl and fr.
- Say what you do not do. Do not invent features, do not touch files outside your plugin except where the guide
  says (registration lines, locale files), and tell me when you did.

## Deliverables (all of them)
1. manifest.json (or the TypeScript manifest object) that passes validateManifest, with category, sections,
   limits, personalisable flags and hard limits on every number. The manifest MUST have `license` (an SPDX id such as
   MIT, Apache-2.0 or GPL-3.0-only, or Proprietary) and `description` (plain text, 10 to 300 characters); it MAY have
   `contact` ({ url (https), email, name }), `package_url` (the https address of the packed .amplugin) and `image`
   ({ file: "assets/example.png", alt } : an example picture for the plugin gallery, PNG/JPEG/WebP, at most 300 KB,
   200 to 1600 px wide, at most 1200 px high). Ask me for
   the licence and contact details; never invent an email address or a web address.
2. The run code (a pure function in its own file, plus the thin module) with progress stages and cancellation.
3. Conformance fixtures (Fixture with tolerances) and tests: pure function, through the engine (Registry +
   runWorkflow), closed solid and volume, groups and segments kept, a code for every error you throw, cancellation,
   determinism, customer rules (what was not handed over cannot be changed), migration if you changed an earlier version.
   Show that the tests can fail: break the code once on purpose and report which tests went red.
4. Texts in en, nl and fr: operation title, sections, parameters (label and help), options, every error and warning
   code (nested under mesh.<prefix>.<code>), every progress stage (ops.<op>.stage.<stage>). A list of the texts for the design team to confirm.
5. A short documentation page: what it does, parameters, problems and what to do, limits, measured times.
6. An example before/after model (3MF or STL) made by a script, and the script.
7. A package: dist/<id>-<version>.amplugin made with the amplugin tool, inspected; or, inside the repository, the
   plugin wired in (registration lines, fixtures export, check-packages probe, locale keys) as described in section 17 of the guide.

## Acceptance checklist (all must be true; report each)
- [ ] validateManifest passes; every default is valid; categories set
- [ ] typecheck and lint are clean; all tests pass; fixtures pass
- [ ] result is a closed solid with the right volume on the example; winding is outward
- [ ] cancellation stops a long run quickly; same input gives the same output twice
- [ ] performance measured on {{size}} triangles; numbers in the report
- [ ] texts exist in en, nl and fr for everything a person can see
- [ ] the package loads in the standalone app (Plugins…, choose the file), appears in the Add a step menu
      under its category, runs on a real model
- [ ] licences of all dependencies are permissive and listed

## Commands to verify
Outside the repository (in your plugin folder inside the unzipped kit; needs Node 20 or newer):
  npm install && npm run typecheck && npm test
  npm run pack && npm run inspect   # the tool is the kit's tools/amplugin.mjs, not an npm package
Inside the repository:
  npm run check                    # typecheck, lint, all unit tests
  npm run check:packages           # the packed tarballs in a clean project, every fixture
  npm run licenses                 # permissive licences only
  npm test -w @ateliermesh/plugins # your plugin's tests (built-in plugin)

## Before you start, ask me (and wait for the answers)
1. Is the plugin a built-in (inside the repository) or an external package I will distribute?
2. What is the largest model it must handle, and how fast must it be?
3. Is a result that is not a closed solid acceptable, or must the plugin refuse or repair?
4. Are there examples of input and expected output I can give you?
5. Any dependency I want you to use or avoid?
6. Who confirms the Dutch and French texts?
7. Which licence should the plugin have (MIT, Apache-2.0, GPL-3.0-only, or Proprietary)? You write it in the manifest as `license`.
8. Which contact details may go in the manifest (a https web address, an email address, a name, or none)? And, if I know it, the https address where the packed .amplugin will be published (`package_url`, so users can check for updates).

## How to report back
Keep it short. Say: what you built (files), the algorithm in a few sentences, the measured numbers (triangles in
and out, time, volume change), every acceptance item ticked or not with the reason, the limits and cases that do
not work, what you changed outside your plugin, the licences, and the questions you still have. Do not claim a
check you did not run; paste the failing output when something fails.
```

---

## The quick prompt (10 lines)

```text
Build an AtelierMesh plugin: {{name}} ({{id}}) that {{what it does in one sentence}}. Category {{category}}.
Settings: {{parameters with defaults and limits}}.
Read docs/plugin-guide.md first (with the plugin kit: README-START-HERE.md first) and copy examples/plugins/mirror-full.
Rules: mm and Z up; closed solid in, closed solid out; never change the input; deterministic (no Math.random, Date, network);
stop on ctx.signal.aborted with MeshError('run.cancelled'); every problem is a MeshError('{{prefix}}.code', { numbers });
keep segments and groups; colour lives on parts, keep them; no materials or prices; UK English texts in en, nl and fr.
Manifest must have license + description (and contact, package_url only if I give them: never invent them). Deliver: manifest, run code, fixtures and tests (including a deliberate break to prove they fail), texts, a short doc page,
an example 3MF, and a packed .amplugin (or, inside the repository, the wiring in section 17 of the guide).
Verify with npm install, npm run typecheck, npm test, npm run pack, npm run inspect (the kit's tools/amplugin.mjs; never the npm package amplugin).
Ask me first: built-in or external, largest model and speed, example input and output, the licence (MIT, Apache-2.0, GPL-3.0-only or Proprietary), contact details (https address, email, name, or none) and where the package will be published (package_url) if known.
Report: files, measured numbers, each acceptance item ticked or not, limits, questions. Do not claim checks you did not run.
```

---

## The full prompt without npm

```text
You are going to build a plugin for AtelierMesh: a plugin turns a 3D mesh into another mesh (a "step"), and a host
(a standalone app, or a web shop) draws its settings from a manifest and runs it. You write no user interface.
YOU HAVE NO NPM: no installs, no network, no TypeScript, no build step. Write PLAIN JAVASCRIPT only: two files,
manifest.json and main.js (one ES module, no imports).

## The plugin I want
- Name and id: {{plugin name}} / {{reverse-domain id, lower case, for example com.mycompany.bevel}}
- What it does, in plain words: {{what it does, for whom, and why a person would add it as a step}}
- Operation(s), each with: {{operation id and title}}, kind {{generator | modifier | analyzer}},
  category {{prepare | shape | surface | check | another lowercase id}}
- Settings the person can change (name, type, default, limits, unit, when it is shown):
  {{list the parameters, for example: "depth, number, 0.5 mm, 0.1 to 5 mm" and "mode, choice of flat or round"}}
- Keep parts: {{does it work on one part (a segment or a body) | does it add a coloured part (a segment name) | none}}
- Input and expected result, as an example I can check: {{a small example, for example "a 20 mm cube, depth 1 mm gives
  a cube with 1 mm bevelled edges, volume about X, still a closed solid"}}
- Performance: {{for example "under 2 seconds for 100 000 triangles", or "interactive: a slider drags it live"}}
- Dependencies: none. Everything is in main.js.

## Tell me first which tools you have
A. Node 20 or newer (no npm)   B. Python 3 only (no Node)   C. only a shell / editor, or you cannot run anything.
Work with the best tier you have and say which one you used.

## Read first, in this order (these four files; the kit is the unzipped plugin kit)
1. README-START-HERE.md
2. docs/NO-NPM.md                      (the three tiers, the rules for plain JavaScript, the exact commands)
3. spec/SPEC-plugins.md                (the plugin parts of the specification: manifest, mesh, parts, runtime contract)
4. examples/plugins/mirror-plain/main.js   (a complete plugin in one file; manifest.json and fixtures.json sit next to it)
If you cannot run anything, also read docs/CONTRACT-CHEATSHEET.md (one page).
Never install the npm package named `amplugin`: it is not ours. Our tools are tools/amplugin.mjs,
tools/amplugin_pack.py and tools/amplugin_check.py in the kit.

## Hard rules
- Millimetres, Z up, triangles counter-clockwise seen from outside. A printable result must be a closed solid
  if the input was one.
- main.js is ONE file: export default { async run(op, ctx) { ... } }. No import, no require.
- Never change ctx.mesh. Build new arrays and return { mesh, report }.
- Deterministic: no Math.random, no Date, no network, no eval, no state between runs. Need randomness? Take a `seed`
  setting and write a small generator. Same input, same output.
- Stop when cancelled: look at ctx.signal.aborted in loops and throw { code: 'run.cancelled', params: {} }.
- Expected problems are PLAIN OBJECTS, not Errors: throw { code: '{{prefix}}.something', params: { numbers a person needs } }.
  An Error counts as a crash and the plugin is switched off.
- Keep segments and groups through your operation (copy mesh.segments / mesh.groups, or carry the labels to new triangles).
- Colour lives on parts; keep them. Every segment and every group can carry a colour (#rrggbb): copy table entries and groups with every field, and give a part you make a colour if it should show one (only #rrggbb is accepted).
- AtelierMesh knows nothing about materials, filaments, prices, precision or infill. Do not add any.
- Hard limits (min, max) in the manifest are real limits.
- Texts for people: UK English, short, say what happened and what to do, with the numbers. Provide en, nl and fr.
- Say what you do not do. Do not invent features, and tell me about anything you touched outside your plugin folder.

## Deliverables (all of them)
1. manifest.json that passes the check (every number has min and max, every default is valid), with `license`, `description`,
   and, if I gave them, `contact` ({ url, email, name }) and `package_url`. Never invent contact details.
2. main.js.
3. fixtures.json: at least a normal case, a case with an expected volume or size, and a refused case with its error code.
4. locales/en.json, nl.json, fr.json: operation title, parameters (label and help), options, every error code
   and warning code, every progress stage. Keys: `ops.<op>.…` (a progress text is `ops.<op>.stage.<stage>`), `step.op.<op>`,
   `mesh.<op or last part of the plugin id>.<code>` for errors and warnings (the host leaves out anything else, and `amplugin check`
   fails it and says where it belongs); plain strings with {{placeholders}}, no markup; at most 64 KB per file.
5. README.md: what it does, settings, problems and what to do, limits.
6. An example result made with `run` (an .stl or .3mf), and the command that made it.
7. A package: <id>-<version>.amplugin.

## How to verify (use your tier; paste the output)
A. node tools/amplugin.mjs check <folder>     (must end with 0 failed)
   node tools/amplugin.mjs run <folder> --input generator:box:10,20,30 --params '{...}' --out result.stl
   node tools/amplugin.mjs pack <folder> --out <id>-<version>.amplugin
   node tools/amplugin.mjs inspect <id>-<version>.amplugin
B. python3 tools/amplugin_check.py <folder>   (static checks only; it cannot run your plugin: say so)
   python3 tools/amplugin_pack.py <folder> --out <id>-<version>.amplugin
   python3 tools/amplugin_check.py <id>-<version>.amplugin
C. Check by reading with the checklist in docs/NO-NPM.md, pack with the sha256sum and zip recipe there,
   and say plainly which checks you could NOT run.

## Before you start, ask me (and wait for the answers)
1. Is the plugin a built-in (inside the repository) or an external package I will distribute?
2. What is the largest model it must handle, and how fast must it be?
3. Is a result that is not a closed solid acceptable, or must the plugin refuse or repair?
4. Are there examples of input and expected output I can give you?
5. Which tier of tools do you have (A, B or C)?
6. Which licence should the plugin have (MIT, Apache-2.0, GPL-3.0-only, or Proprietary)? You write it in the manifest as `license`.
7. Which contact details may go in the manifest (a https web address, an email address, a name, or none)? And, if I know it, the https address where the packed .amplugin will be published (`package_url`).

## How to report back
Keep it short. Say: the tier you used; the files you created; the algorithm in a few sentences; the output of
every check you ran, pasted; the checks you could NOT run; the sha256 of the .amplugin (sha256sum <file>); the
limits and cases that do not work; and the questions you still have. Do not claim a check you did not run.
Tell me to run `node tools/amplugin.mjs check <folder>` where Node exists if you could not.
```

---

## The quick prompt without npm (10 lines)

```text
Build an AtelierMesh plugin with NO npm: {{name}} ({{id}}) that {{what it does in one sentence}}. Category {{category}}.
Settings: {{parameters with defaults and limits}}. Write plain JavaScript only: manifest.json (with license and description), main.js (one file, no imports), fixtures.json, locales/en|nl|fr.json.
Read in this order: README-START-HERE.md, docs/NO-NPM.md, spec/SPEC-plugins.md (plugin parts), examples/plugins/mirror-plain/main.js. Cannot run anything? Also docs/CONTRACT-CHEATSHEET.md.
Rules: mm and Z up; closed solid in, closed solid out; never change ctx.mesh; deterministic (no Math.random, Date, network); stop on ctx.signal.aborted with throw { code: 'run.cancelled', params: {} };
every problem is a plain object throw { code: '{{prefix}}.code', params: { numbers } }, never an Error; keep segments and groups; colour lives on parts, keep them; no materials or prices; UK English texts.
Verify with what you have: Node: node tools/amplugin.mjs check <folder>, run, pack, inspect. Python 3 only: python3 tools/amplugin_check.py and amplugin_pack.py (static checks). Nothing: read it against the checklist in docs/NO-NPM.md and pack with sha256sum and zip.
Never install the npm package named amplugin (not ours). Deliver: the files, an example result, the .amplugin.
Ask me first: which tools you have (Node, Python 3, or only a shell), largest model and speed, example input and output, the licence (MIT, Apache-2.0, GPL-3.0-only or Proprietary), contact details (https address, email, name, or none) and where the package will be published (package_url) if known.
Report: tier used, files, every check output pasted, the checks you could not run, the sha256 of the .amplugin, limits, questions. Do not claim checks you did not run.
```
