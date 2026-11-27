// Runs in the browser: mounts the overlay with the real engine (in this thread), a plate and one font.
import * as THREE from 'three'
import { createRoot } from 'react-dom/client'
import { Registry, addStep, emptyStepList, makeStep, runWorkflow } from '@ateliermesh/core'
import type { StepList, WorkflowResult } from '@ateliermesh/core'
import type { Viewer } from '@ateliermesh/ui'
import { CORE_PLUGIN_ID, CORE_PLUGIN_VERSION, corePlugin, lowpolyPlugin, voronoiPlugin, repairPlugin, deformPlugin, partsPlugin, texturePlugin, hollowPlugin, holesPlugin, printcheckPlugin, gridBox } from '@ateliermesh/plugins'
import { PersonaliseOverlay } from '../../src'
import en from '../../../../apps/standalone/src/locales/en.json'

const flat = (d: unknown, p = ''): Record<string, string> => Object.entries(d as Record<string, unknown>).reduce((o, [k, v]) => (typeof v === 'object' && v !== null ? { ...o, ...flat(v, `${p}${k}.`) } : { ...o, [`${p}${k}`]: String(v) }), {} as Record<string, string>)
const dict = flat(en)
const t = (key: string, values: Record<string, string | number> = {}): string => (dict[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, n: string) => String(values[n] ?? `{{${n}}}`))

const w = window as unknown as { __font: string; __t: Record<string, unknown> }
const fontBytes = (): Uint8Array => Uint8Array.from(atob(w.__font), c => c.charCodeAt(0))
const registry = new Registry().register(corePlugin()).register(lowpolyPlugin()).register(voronoiPlugin()).register(repairPlugin()).register(deformPlugin()).register(partsPlugin()).register(texturePlugin()).register(hollowPlugin()).register(holesPlugin()).register(printcheckPlugin())
const plate = gridBox(70, 30, 4, 140, 60, 8)

const placement = { anchor: { point: [0, 0, 4], normal: [0, 0, 1] }, direction: 0, limits: { max_distance: 3, direction: [-45, 45], size: [4, 10] } }
const make = (customer: string[]): StepList => addStep(emptyStepList(), makeStep({
  id: 't1', plugin: { id: CORE_PLUGIN_ID, version: CORE_PLUGIN_VERSION }, op: 'emboss',
  params: { text: 'Lotte', font: 'roboto', size: 8, height: 0.8, placement },
  personalisable_params: customer, personalisable_limits: { text: { max_lines: 1, max_line_length: 20 } },
}))
let designer = make(['text', 'size', 'placement.direction'])
let viewer: Viewer | null = null
let lastList: StepList | null = null

let last: WorkflowResult | null = null
let done: StepList | null = null
let closed = 0
let gate: Promise<void> | null = null, openGate: (() => void) | null = null
const run = async (list: StepList, o: { signal: AbortSignal }): Promise<WorkflowResult> => {
  lastList = list
  if (gate) await gate        // a test can keep the run pending (hold) and let it go later (release)
  last = await runWorkflow(list, { registry, source: plate, signal: o.signal, quality: 'preview', assets: async () => fontBytes() })
  return last
}

w.__t = {
  hold() { gate = new Promise<void>(res => { openGate = res }) },
  release() { openGate?.(); gate = null },
  start(opts?: { colours?: boolean; position?: boolean; title?: string; initial?: { params?: Record<string, unknown>; open?: string[] }; hold?: boolean }) {
    if (opts?.position) designer = make(['text', 'size', 'placement.position'])
    if (opts?.hold) (w.__t as { hold(): void }).hold()
    // the customer's list from an earlier visit: the designer's step with other values and, if a test wants, its own idea of what is open
    const ini = opts?.initial
    const initialList = ini ? { ...designer, steps: designer.steps.map(st => ({ ...st, params: { ...st.params, ...(ini.params ?? {}) }, ...(ini.open ? { personalisable_params: ini.open } : {}) })) } : undefined
    const el = document.createElement('div'); document.body.append(el)
    createRoot(el).render(<PersonaliseOverlay list={designer} {...(opts?.colours ? { colours: { map: { slots: [{ id: '1', name: 'Plate', parts: ['body'] }, { id: '2', name: 'Name', parts: ['text'] }] }, colours: { '1': { color: '#ff0000' }, '2': { color: '#00ff00' } } } } : {})} {...(initialList ? { initialList } : {})} registry={registry} run={run} t={t} three={THREE} fonts={[{ id: 'roboto', family: 'Roboto' }, { id: 'pacifico', family: 'Pacifico' }]} title={opts?.title ?? 'Personalise'} subtitle="Name tag" onDone={l => { done = l }} onClose={() => { closed++ }} onViewer={v => { viewer = v }} debounceMs={20} />)
  },
  /** The distinct vertex colours the viewer draws now, as r,g,b. */
  colourList: () => { const set = new Set<string>(); viewer?.scene.traverse(obj => { const a = (obj as unknown as { geometry?: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } | undefined } }).geometry?.getAttribute?.("color"); if (a) for (let i = 0; i < a.count; i++) set.add(`${a.getX(i).toFixed(3)},${a.getY(i).toFixed(3)},${a.getZ(i).toFixed(3)}`) }); return [...set] },
  /** Where the grip is on the screen, and where a point `dx` mm to the right of the shop's spot is. */
  gripAt: (dx: number) => {
    const pl = (lastList?.steps[0]?.params['placement'] as { anchor: { point: number[]; normal: number[] } } | undefined)
    if (!viewer || !pl) return null
    const n = pl.anchor.normal as [number, number, number], p = pl.anchor.point as [number, number, number]
    const at = (x: number): { x: number; y: number } | null => viewer!.project([x + n[0] * 0.3, p[1] + n[1] * 0.3, p[2] + n[2] * 0.3])
    return { from: at(p[0]), to: at(p[0] + dx) }
  },
  anchorX: () => (lastList?.steps[0]?.params['placement'] as { anchor: { point: number[] } } | undefined)?.anchor.point[0] ?? null,
  status: () => ({ ok: last?.ok ?? null, triangles: last?.mesh ? last.mesh.indices.length / 3 : 0, error: last?.results[0]?.error?.code ?? null, done: done ? (done.steps[0]?.params as Record<string, unknown>) : null, closed }),
}
