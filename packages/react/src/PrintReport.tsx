// The report card of the printability check: a verdict, a score, and one line per finding with a coloured dot. A finding that has flagged triangles gets a
// "Show in 3D" button that lights them up in the view. The step's warnings carry the same sentences as the card, so the notes of the step leave them out.
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { Mesh, Step, StepList, WorkflowResult } from '@ateliermesh/core'
import { describeProblem } from '@ateliermesh/ui'
import type { Viewer } from '@ateliermesh/ui'
import { expandRuns } from '@ateliermesh/plugins'
import type { PrintCheckResult, PrintFinding } from '@ateliermesh/plugins'
import type { T } from './common'
import { problemText, tx } from './common'

/** Whether a step's report is the printability report (a verdict, a score and a list of findings). */
export function isPrintReport(r: unknown): r is PrintCheckResult {
  const x = r as Partial<PrintCheckResult> | null | undefined
  return !!x && typeof x === 'object' && typeof x.verdict === 'string' && typeof x.score === 'number' && Array.isArray(x.findings)
}

const FALLBACK_OK: Record<string, string> = {
  not_closed: 'A closed solid.', islands: 'One piece.', thin_walls: 'Walls are thick enough.', thin_features: 'No posts or pins that are too thin.', narrow_gaps: 'Gaps are wide enough.',
  needs_support: 'No overhang over {{angle}}°.', long_bridges: 'No long bridges.', tiny_base: 'A flat base of {{area}} mm² on the bed.', too_tall: 'Height {{height}} mm for a width of {{width}} mm.',
  too_big_for_bed: 'It fits the build volume.', floating_body: 'No part floats above the plate.', island: 'Nothing starts in mid-air.', overhang: 'No overhang that needs support.', bridge: 'No bridge that is too long.', needles: 'No needle-like triangles.', detail: '{{count}} triangles.',
}
const FALLBACK_INFO: Record<string, string> = {
  islands: '{{shells}} separate pieces (the smallest {{smallest}} mm). That is fine if they all rest on the bed.', thin_walls: 'A few places are thinner than {{min}} mm (thinnest {{thinnest}} mm).',
  thin_features: 'A few thin posts or pins (thinnest {{thinnest}} mm).', narrow_gaps: 'A few narrow gaps (narrowest {{narrowest}} mm).',
  needs_support: 'A little overhang ({{area}} mm², {{percent}} % of the surface).', needles: '{{count}} needle-like triangles (angles under 5°). Usually harmless.', detail: '{{count}} triangles.',
}
const COLOUR: Record<string, string> = { error: '#dc2626', warning: '#d97706', info: '#6366f1', ok: '#15803d' }
/** The places where the print starts in mid-air have a colour of their own (the dot of the row is the legend of the light in the 3D view). */
const PLACE_COLOUR: Record<string, string> = { floating_body: '#a21caf', island: '#0e7490', overhang: '#ea580c', bridge: '#2563eb' }
const colourOf = (f: PrintFinding): string => (f.severity === 'ok' ? undefined : PLACE_COLOUR[f.name]) ?? COLOUR[f.severity] ?? '#6366f1'

const values = (f: PrintFinding): Record<string, string | number> => Object.fromEntries(Object.entries(f.params).filter(([, v]) => typeof v === 'number' || typeof v === 'string')) as Record<string, string | number>

/** The sentence of one finding, in the chosen language. */
export function findingText(t: T, f: PrintFinding): string {
  if (f.severity === 'warning' || f.severity === 'error') {
    const v = describeProblem(f.code, f.params as Record<string, unknown>)
    const k = t(v.key) !== v.key ? v.key : 'mesh.unknown'
    return problemText(t, k, { ...v.values, code: f.code })
  }
  const group = f.severity === 'info' ? 'info' : 'ok'
  const key = `printcheck.${group}.${f.name}`
  return tx(t, key, (f.severity === 'info' ? FALLBACK_INFO[f.name] : undefined) ?? FALLBACK_OK[f.name] ?? f.name, values(f))
}

export interface PrintReportProps { t: T; report: PrintCheckResult; viewer: Viewer | null; /** Whether the view shows the mesh these triangle numbers belong to. */ canShow: boolean }

export function PrintReport({ t, report, viewer, canShow }: PrintReportProps): ReactElement {
  const [shown, setShown] = useState<string | null>(null)
  // clear the light when the card goes away or the report is replaced
  useEffect(() => () => { viewer?.highlight(null) }, [viewer])
  useEffect(() => { setShown(null); viewer?.highlight(null) }, [report, viewer])
  const rows = useMemo(() => {
    const order = { error: 0, warning: 1, info: 2, ok: 3 } as const
    // the older "needs support" and "long bridges" lines say the same as the overhang and bridge lines that came later: show the newer ones
    const newer = (n: string): boolean => report.findings.some(f => f.name === n && (f.severity === 'warning' || f.severity === 'error'))
    const hidden = (f: PrintFinding): boolean => (f.name === 'needs_support' && f.severity !== 'ok' && newer('overhang')) || (f.name === 'long_bridges' && f.severity !== 'ok' && newer('bridge'))
    return report.findings.filter(f => !hidden(f)).sort((a, b) => order[a.severity] - order[b.severity])
  }, [report])
  const problems = rows.filter(f => f.severity === 'error' || f.severity === 'warning' || f.severity === 'info')
  const passed = rows.filter(f => f.severity === 'ok')
  const toggle = (f: PrintFinding): void => {
    if (!viewer || !f.triangles) return
    if (shown === f.name) { viewer.highlight(null); setShown(null); return }
    viewer.highlight(expandRuns(f.triangles), colourOf(f))
    setShown(f.name)
  }
  const line = (f: PrintFinding): ReactElement => (
    <li key={f.name} className={`am-pr-row am-pr-${f.severity}`}>
      <span className="am-pr-dot" style={{ background: colourOf(f) }} aria-hidden="true" />
      <span className="am-sr">{t(`printcheck.severity.${f.severity}`) === `printcheck.severity.${f.severity}` ? f.severity : t(`printcheck.severity.${f.severity}`)}: </span>
      <span className="am-pr-text">{findingText(t, f)}</span>
      {f.triangles && f.triangles.length > 0 ? (
        <button type="button" className="am-pr-show" aria-pressed={shown === f.name} disabled={!canShow} onClick={() => toggle(f)}>
          {shown === f.name ? tx(t, 'printcheck.hide', 'Hide in 3D') : tx(t, 'printcheck.show', 'Show in 3D')}
          <span className="am-sr"> — {findingText(t, f)}</span>
        </button>
      ) : null}
    </li>
  )
  return (
    <section className="am-printreport" aria-label={tx(t, 'printcheck.reportLabel', 'Print check report')} data-verdict={report.verdict}>
      <header className="am-pr-head">
        <strong className={`am-pr-verdict am-pr-v-${report.verdict}`}>{tx(t, `printcheck.verdict.${report.verdict}`, report.verdict === 'good' ? 'Good to print' : report.verdict === 'fix_recommended' ? 'Fix recommended' : 'Not printable as it is')}</strong>
        <span className="am-pr-score">{tx(t, 'printcheck.score', 'Score {{score}} of 100', { score: report.score })}</span>
      </header>
      {!canShow && problems.some(f => f.triangles && f.triangles.length > 0) ? <p className="am-help">{tx(t, 'printcheck.showLast', 'Put this step last to see the places in 3D.')}</p> : null}
      {problems.length > 0 ? <ul className="am-pr-list">{problems.map(line)}</ul> : null}
      {passed.length > 0 ? (
        <details className="am-pr-passed">
          <summary>{tx(t, 'printcheck.passed', '{{count}} checks passed', { count: passed.length })}</summary>
          <ul className="am-pr-list">{passed.map(line)}</ul>
        </details>
      ) : null}
      <p className="am-help am-pr-note">{tx(t, 'printcheck.note', 'Checked on {{samples}} points of the surface, for {{process}} with a {{wall}} mm wall limit.', { samples: report.samples, process: report.thresholds.process === 'resin' ? 'resin' : 'FDM', wall: report.thresholds.min_wall })}</p>
    </section>
  )
}

/** The card for a step of the list, when that step ran the printability check. `canShow`: the view shows exactly the mesh this step checked. */
export function PrintReportCard({ t, result, list, step, viewer }: { t: T; result: WorkflowResult | null; list: StepList; step: Step; viewer: Viewer | null }): ReactElement | null {
  const i = list.steps.findIndex(x => x.id === step.id)
  const r = result?.results[i]
  if (!r || !isPrintReport(r.report)) return null
  const mesh: Mesh | undefined = r.mesh
  return <PrintReport t={t} report={r.report} viewer={viewer} canShow={!!mesh && mesh === result?.mesh} />
}
