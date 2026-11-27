// Runs in the browser: mounts the editor page with the real engine (in this thread), a plate, one font and a tiny plugin that names a part.
import * as THREE from 'three'
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Registry, addStep, emptyStepList, makeStep, parseRecipe, runWorkflow } from '@ateliermesh/core'
import type { Recipe, Manifest, Operation, StepList } from '@ateliermesh/core'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin, lowpolyPlugin, voronoiPlugin, repairPlugin, deformPlugin, partsPlugin, texturePlugin, hollowPlugin, holesPlugin, printcheckPlugin, gridBox } from '@ateliermesh/plugins'
import { EditorPage, useRegistryVersion } from '../../src'
import type { EditorHandle, EditorState } from '../../src'
import en from '../../../../apps/standalone/src/locales/en.json'

const flat = (d: unknown, p = ''): Record<string, string> => Object.entries(d as Record<string, unknown>).reduce((o, [k, v]) => (typeof v === 'object' && v !== null ? { ...o, ...flat(v, `${p}${k}.`) } : { ...o, [`${p}${k}`]: String(v) }), {} as Record<string, string>)
const dict = flat(en)
const t = (key: string, values: Record<string, string | number> = {}): string => (dict[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

const w = window as unknown as { __font: string; __opts: Record<string, unknown>; __e: Record<string, unknown> }
const fontBytes = (): Uint8Array => Uint8Array.from(atob(w.__font), c => c.charCodeAt(0))
const partsManifest: Manifest = { manifest_version: 1, id: 'test.parts', name: 'Parts', version: '1.0.0', operations: [
  { id: 'use', title: 'Use a part', kind: 'modifier', params: [{ name: 'only', type: 'part', default: '' }] },
] as unknown as Operation[] }
const crashManifest: Manifest = { manifest_version: 1, id: 'test.crash', name: 'Crashy', version: '1.0.0', operations: [
  { id: 'boom', title: 'Boom', kind: 'modifier', params: [] },
] as unknown as Operation[] }
// a plugin that says only what its fields are and a few hints: the one general form draws it in the designed look
const hintsManifest: Manifest = { manifest_version: 1, id: 'test.hints', name: 'Hints', version: '1.0.0', operations: [
  { id: 'tune', title: 'Tune', kind: 'modifier', icon: 'twist', summary: '{{strength}} x', params: [
    { name: 'strength', type: 'float', default: 5, min: 0, max: 10, step: 0.5, unit: 'mm', widget: 'slider', importance: 'main', help: 'How hard it works.' },
    { name: 'style', type: 'enum', default: 'soft', options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard', icon: 'raised' }], widget: 'segmented', importance: 'main' },
    { name: 'kind', type: 'enum', default: 'a', options: ['a', 'b', 'c'], widget: 'cards' },
    { name: 'tweak', type: 'int', default: 3, min: 1, max: 9, widget: 'stepper', importance: 'advanced' },
  ] },
] as unknown as Operation[] }
const PIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const registry = new Registry().register(corePlugin()).register(lowpolyPlugin()).register(voronoiPlugin()).register(repairPlugin()).register(deformPlugin()).register(partsPlugin()).register(texturePlugin()).register(hollowPlugin()).register(holesPlugin()).register(printcheckPlugin()).register({ manifest: hintsManifest, load: () => ({ run: (_op, ctx) => ({ mesh: ctx.mesh as never }) }) }).register({ manifest: partsManifest, load: () => ({ run: (_op, ctx) => ({ mesh: ctx.mesh as never }) }) }).register({ manifest: crashManifest, load: () => ({ run: () => { throw new ReferenceError('oops is not defined') } }) })
const plate = gridBox(70, 30, 4, 140, 60, 8)

const text = makeStep({ id: 's1', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss', params: { text: 'Lotte', font: 'roboto', size: 8, height: 0.8, placement: { anchor: { point: [0, 0, 4], normal: [0, 0, 1] }, direction: 0 } } })
const state = { recipes: [] as Recipe[], saves: [] as Array<{ where: string; name: string; ops: string[] }>, list: addStep(emptyStepList(), text), left: 0, saved: 0, reasons: [] as string[], plugin: [] as string[], showPers: false, pers: false }
const states: EditorState[] = []
const editorRef: { current: EditorHandle | null } = { current: null }
let rerender: () => void = () => {}

const onState = (s: EditorState): void => { states.push(s) }
function App(): JSX.Element {
  const [list, setList] = useState<StepList>(state.list)
  const [pers, setPers] = useState(false)
  const [show, setShow] = useState(false)
  useRegistryVersion(registry)
  // a slow engine for the waiting tests: `delay` ms, with a stage report; when the signal fires (Stop, or a newer change) it answers like the real runner does for a stopped run
  const run = useCallback(async (l: StepList, o: { signal: AbortSignal; onProgress?: (stepId: string, stage: string, fraction: number) => void }) => {
    const ms = Number(w.__opts['delay'] ?? 0)
    const base = { registry, source: plate, quality: 'preview' as const, assets: async () => fontBytes() }
    if (ms > 0) {
      o.onProgress?.(l.steps[0]?.id ?? 's1', 'cut', 0.4)
      await new Promise<void>(res => { const id = setTimeout(res, ms); o.signal.addEventListener('abort', () => { clearTimeout(id); res() }) })
      if (o.signal.aborted) { const dead = new AbortController(); dead.abort(); return runWorkflow(l, { ...base, signal: dead.signal }) }
    }
    return runWorkflow(l, { ...base, signal: o.signal, ...(o.onProgress ? { onProgress: o.onProgress } : {}) })
  }, [])
  const [, setTick] = useState(0)
  rerender = () => { setList(state.list); setTick(n => n + 1) }
  return (
    <EditorPage ref={editorRef} title="Editor" t={t} registry={registry} three={THREE} list={list} run={run} source={plate} baseParts={{ segments: [], groups: [] }} file={{ name: 'plate.stl', width: 140 }} mode={(w.__opts['mode'] as 'standalone' | 'designer') ?? 'standalone'}
      onListChange={(l, why) => { state.list = l; state.reasons.push(why); setList(l) }} personalised={pers} onPersonalised={v => { state.pers = v; setPers(v) }}
      settings={{ showPersonalised: show, onShowPersonalised: v => { state.showPers = v; setShow(v) } }}
      plugins={{ ...(w.__opts['build'] ? { build: w.__opts['build'] as { guideUrl?: string; promptText?: string; exampleUrl?: string; kitUrl?: string } } : {}), plugins: [{ id: CORE_PLUGIN_ID, name: 'AtelierMesh', version: CORE_PLUGIN_VERSION, builtIn: true, usedBy: list.steps.length }, { id: 'test.parts', name: 'Parts', version: '1.0.0', builtIn: false, usedBy: 0, signed: false }, { id: 'test.crash', name: 'Crashy', version: '1.0.0', builtIn: false, usedBy: 0, signed: false }].map(r => { const off = registry.disabledPlugins()[r.id]; return off ? { ...r, disabled: { reason: off.reason, crashed: off.crashed } } : r }),
        onToggle: (id, on) => { registry.setEnabled(id, on) },
        onLoadFile: f => { state.plugin.push(`file:${f.name}`) }, onLoadUrl: u => { state.plugin.push(`url:${u}`) }, onRemove: id => { state.plugin.push(`remove:${id}`) } }}
      recipes={{
        entries: state.recipes.map((r, i) => ({ id: `r${i}`, name: r.name, steps: r.steps.steps.length })),
        load: async id => state.recipes[Number(id.slice(1))] ?? null,
        save: (r, where) => { state.saves.push({ where, name: r.name, ops: r.steps.steps.map(x => x.op) }); if (where === 'browser') { state.recipes.push(r); rerender() } },
      }}
      dirty={w.__opts['dirty'] === true} savedAt="14:32" onSave={() => { state.saved++ }} onLeave={() => { state.left++ }} onViewer={v => { (window as unknown as { __viewer: unknown }).__viewer = v }} debounceMs={20}
      {...(w.__opts['chrome'] ? { chrome: w.__opts['chrome'] as 'full' | 'none' } : {})} {...(w.__opts['layout'] ? { layout: w.__opts['layout'] as 'columns' | 'embedded' } : {})}
      {...(w.__opts['colours'] ? { colours: { map: { slots: [{ id: '1', name: 'Plate', parts: ['body'] }] }, onChange: () => {} } } : {})}
      {...(w.__opts['tabs'] ? { sheetTabs: [{ id: 'print', label: 'Print', content: <div><p>Print settings</p><button type="button">Print option</button></div> }] } : {})}
      {...(w.__opts['footer'] ? { sheetFooter: <button type="button" className="host-next" style={{ width: '100%', minHeight: 48 }}>Next: Preview</button> } : {})}
      {...(w.__opts['pictures'] ? { pictures: { items: (lib: string | undefined) => (lib === 'textures' ? [{ id: 'texture:a', name: 'Stripes', url: PIX, category: 'Lines' }, { id: 'texture:b', name: 'Dots', url: PIX, category: 'Shapes' }] : []) } } : {})} onAsset={(stepId, param) => { state.plugin.push(`asset:${stepId}:${param}`) }} {...((w.__opts['props'] ?? {}) as object)} {...(w.__opts['headerText'] ? { header: <p className="host-header">{String(w.__opts['headerText'])}</p> } : {})}
      onState={onState} />
  )
}

w.__e = {
  states: () => states,
  request: (on: boolean) => editorRef.current!.requestPersonalised(on).then(r => { (w as unknown as { __req: boolean }).__req = r; return r }),
  current: () => editorRef.current!.getState(),
  setDelay(ms: number) { w.__opts['delay'] = ms },
  start() { { const store: Record<string, string> = { ...((w.__opts['seed'] ?? {}) as Record<string, string>) }; (w as unknown as { __store: unknown }).__store = store; Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v } } }) } const el = document.createElement('div'); if (w.__opts['chrome'] === 'none') { el.style.height = '100dvh'; document.documentElement.style.height = '100%'; document.body.style.height = '100%' }; document.body.append(el); createRoot(el).render(<App />) },
  addCrashStep() { state.list = addStep(state.list, makeStep({ id: 's8', plugin: { id: 'test.crash', version: '1.0.0' }, op: 'boom' })); rerender() },
  addRecipe(text: string) { const r = parseRecipe(text); if (!r.ok) throw new Error(JSON.stringify(r.errors)); state.recipes.push(r.recipe); rerender() },
  addStepRaw(plugin: string, version: string, op: string, params: Record<string, unknown>) { state.list = addStep(state.list, makeStep({ id: `s${state.list.steps.length + 10}`, plugin: { id: plugin, version }, op, params })); rerender() },
  addPartsStep(only: string) { state.list = addStep(state.list, makeStep({ id: 's9', plugin: { id: 'test.parts', version: '1.0.0' }, op: 'use', params: { only } })); rerender() },
  state: () => ({ saves: state.saves, steps: state.list.steps.map(s => `${s.id}:${s.op}`), left: state.left, saved: state.saved, reasons: state.reasons, plugin: state.plugin, showPers: state.showPers, pers: state.pers, personalisable: state.list.steps.map(s => s.personalisable_params) }),
}
