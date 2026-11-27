// The files `amplugin new <name>` writes: a plain JavaScript plugin (no build, no npm) with a manifest, fixtures and texts.
// The plugin shifts a model by x, y and z millimetres. It is small on purpose: it shows the contract, the structured error, cancelling, and keeping labels.

const title = (name: string): string => name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

export function newPluginFiles(name: string): Record<string, string> {
  const id = `com.example.${name.replace(/-/g, '_')}`
  const manifest = {
    manifest_version: 1,
    id,
    name: title(name),
    version: '0.1.0',
    author: 'Your name',
    license: 'MIT',
    description: 'Shifts a model by x, y and z millimetres. A starting point: change it to do your own thing.',
    contact: { name: 'Your name', email: 'you@example.org' },
    operations: [{
      id: 'shift', title: 'Shift', kind: 'modifier', category: 'shape', personalisable: 'never', stages: ['shift'],
      outputs: { mesh: true, report: true, closed: true },
      params: [
        { name: 'x', type: 'float', default: 0, min: -1000, max: 1000, step: 0.5, unit: 'mm' },
        { name: 'y', type: 'float', default: 0, min: -1000, max: 1000, step: 0.5, unit: 'mm' },
        { name: 'z', type: 'float', default: 0, min: -1000, max: 1000, step: 0.5, unit: 'mm' },
      ],
    }],
  }
  const main = `// ${title(name)}: a plugin is ONE ES module (this file) whose default export has a run(op, ctx) function.
// Rules: no imports, no network, no clock, no random numbers, and never change ctx.mesh: build a new mesh. Millimetres, Z up.
// A problem you expect is thrown as a plain object { code, params } (NOT an Error): the code starts with your plugin's prefix, the params carry the numbers.
// The mesh is { positions: Float64Array (x, y, z per vertex), indices: Uint32Array (three per triangle), segments?, groups? }.

const problem = (code, params = {}) => ({ code, params })

export default {
  async run(op, ctx) {
    if (op !== 'shift') throw problem('step.unknown_op', { op })
    const mesh = ctx.mesh
    if (!mesh) throw problem('input.missing_mesh', { op })
    if (mesh.indices.length === 0) throw problem('shift.empty')            // an expected problem has a code the host can translate
    ctx.progress('shift', 0)
    const d = [ctx.params.x, ctx.params.y, ctx.params.z]
    const positions = new Float64Array(mesh.positions.length)
    for (let i = 0; i < positions.length; i++) {
      if ((i & 0xffff) === 0 && ctx.signal.aborted) throw problem('run.cancelled')   // stop when the user cancels (look every few thousand steps)
      positions[i] = mesh.positions[i] + d[i % 3]
    }
    ctx.progress('shift', 1)
    // the triangles are the same triangles, so the labels carry over untouched: segments (colour parts) and groups (bodies)
    const out = { positions, indices: mesh.indices }
    if (mesh.segments) out.segments = mesh.segments
    if (mesh.groups) out.groups = mesh.groups
    return { mesh: out, report: { moved: d } }
  },
}
`
  const fixtures = [
    { name: 'a shift does not change size, volume or triangles', operation: 'shift', params: { x: 5, y: -2, z: 1 },
      input: { generator: 'box', params: { width: 10, depth: 20, height: 30 } },
      expect: { triangles: 12, volume: { value: 6000, tol: 1e-6 }, size: { value: [10, 20, 30], tol: 1e-9 }, watertight: true } },
    { name: 'a shift above the limit is refused', operation: 'shift', params: { x: 5000 }, input: { generator: 'box' }, expect: { ok: false, error_code: 'param.out_of_range' } },
  ]
  const texts = (s: string, x: string, h: string, empty: string, stage: string): string => JSON.stringify({
    // the progress text of the stage named in `stages` (ops.<operation id>.stage.<stage>); error texts go under mesh.<prefix>.<code>
    ops: { shift: { title: s, params: { x: { label: x, help: h } }, stage: { shift: stage } } },
    step: { op: { shift: s } },
    mesh: { shift: { empty } },
  }, null, 2) + '\n'
  const readme = `# ${title(name)}

A plain JavaScript plugin for AtelierMesh: \`manifest.json\` says what it is, \`main.js\` does the work, \`fixtures.json\` holds the checks, \`locales/\` the words.
No npm, no build.

\`\`\`
node ../tools/amplugin.mjs check .                       # manifest, rules, every operation on test models, determinism, cancelling, your fixtures
node ../tools/amplugin.mjs run . --input generator:box:10,20,30 --params '{"x":5}' --out result.stl
node ../tools/amplugin.mjs pack . --out ${id}-0.1.0.amplugin
node ../tools/amplugin.mjs inspect ${id}-0.1.0.amplugin
\`\`\`

(Adjust the path to \`amplugin.mjs\`: it is in the \`tools/\` folder of the plugin kit.)

Change the id in \`manifest.json\` before you share it. Texts go in English (UK spelling), Dutch and French.
`
  return {
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'main.js': main,
    'fixtures.json': JSON.stringify(fixtures, null, 2) + '\n',
    'README.md': readme,
    'locales/en.json': texts('Shift', 'Move along X', 'How far the model moves along X.', 'The model has no triangles to move.', 'Moving the model…'),
    'locales/nl.json': texts('Verschuiven', 'Verschuiving in X', 'Hoever het model langs X verschuift.', 'Het model heeft geen driehoeken om te verschuiven.', 'Het model verschuiven…'),
    'locales/fr.json': texts('Décaler', 'Décalage en X', 'De combien le modèle se déplace selon X.', 'Le modèle n’a aucun triangle à déplacer.', 'Déplacement du modèle…'),
  }
}
