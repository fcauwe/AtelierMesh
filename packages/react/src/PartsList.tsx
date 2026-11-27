// "Parts": every segment (colour part) and body of the model as it is now, with its colour, its triangle count and a highlight in the view.
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { segmentTable } from '@ateliermesh/core'
import type { Mesh } from '@ateliermesh/core'
import { partColor } from '@ateliermesh/ui'
import type { Viewer } from '@ateliermesh/ui'
import type { T } from './common'
import { tx } from './common'

export function PartsList({ t, mesh, viewer }: { t: T; mesh: Mesh | null; viewer: Viewer | null }): ReactElement | null {
  const [on, setOn] = useState<string | null>(null)
  const rows = useMemo(() => {
    if (!mesh) return []
    const table = segmentTable(mesh), nt = mesh.indices.length / 3
    const counts = new Map<number, number>()
    for (let i = 0; i < nt; i++) { const l = mesh.segments ? (mesh.segments.labels[i] as number) : 0; counts.set(l, (counts.get(l) ?? 0) + 1) }
    const segs = table.map((s, i) => ({ key: `s${s.id}`, kind: 'segment' as const, name: s.name, color: partColor(i, s.color), count: counts.get(s.id) ?? 0, id: s.id }))
    const bodies = (mesh.groups ?? []).map((g, i) => ({ key: `g${i}`, kind: 'body' as const, name: g.name ?? `${i + 1}`, role: g.role, count: g.count, start: g.start, color: g.color }))
    return [...segs, ...bodies]
  }, [mesh])
  if (!mesh || rows.length === 0) return null
  const show = (r: (typeof rows)[number] | null): void => {
    setOn(r?.key ?? null)
    if (!viewer || !mesh) return
    if (!r) { viewer.highlight(null); return }
    const nt = mesh.indices.length / 3, tris: number[] = []
    if (r.kind === 'segment') { for (let i = 0; i < nt; i++) if ((mesh.segments ? (mesh.segments.labels[i] as number) : 0) === r.id) tris.push(i) }
    else for (let i = r.start; i < r.start + r.count && i < nt; i++) tris.push(i)
    viewer.highlight(tris, '#ffd400')
  }
  const seg = rows.filter(r => r.kind === 'segment'), bod = rows.filter(r => r.kind === 'body')
  const row = (r: (typeof rows)[number]): ReactElement => (
    <li key={r.key}>
      <button type="button" aria-pressed={on === r.key} onClick={() => show(on === r.key ? null : r)} onMouseEnter={() => { if (on === null) viewer?.highlight(null) }}>
        {r.kind === 'segment' ? <span className="am-swatch-dot" style={{ background: r.color }} aria-hidden="true" /> : <span className={`am-swatch-dot${r.color ? '' : ' am-body-dot'}`} style={r.color ? { background: r.color } : undefined} aria-hidden="true" />}
        <span className="am-t1">{r.name}{r.kind === 'body' && r.role === 'negative' ? ` (${tx(t, 'parts.negative', 'cuts away')})` : ''}</span>
        <span className="am-t2">{tx(t, 'parts.triangles', '{{count}} triangles', { count: r.count })}</span>
      </button>
    </li>
  )
  return (
    <details className="am-parts">
      <summary>{tx(t, 'parts.title', 'Parts')}</summary>
      <p className="am-parts-h">{tx(t, 'parts.segments', 'Colour parts')}</p>
      <ul>{seg.map(row)}</ul>
      {bod.length > 0 ? <><p className="am-parts-h">{tx(t, 'parts.bodies', 'Bodies')}</p><ul>{bod.map(row)}</ul></> : null}
    </details>
  )
}
