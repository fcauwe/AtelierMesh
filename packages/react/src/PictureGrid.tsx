// The picture picker for an asset setting with `widget: "gallery"` (a pattern picture, a texture): a grid of thumbnails from the host's library, a "None" tile and an
// upload tile. The host owns the pictures (`PictureLibrary`); the engine only ever sees the id the customer picks.
import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ParamDef } from '@ateliermesh/core'

export interface PictureChoice {
  /** The asset id the step stores (what `ctx.assets(id)` will be asked for). */
  id: string
  name: string
  /** A small picture to show (an object URL or a path). */
  url: string
  /** A group name; with more than one group the grid offers a filter. */
  category?: string
}

export interface PictureLibrary {
  /** The pictures for a setting's `library` name (`textures`, ...); undefined when the setting names none. Called on every render: keep it cheap. */
  items: (library: string | undefined) => PictureChoice[]
}

export const PicturesContext = createContext<PictureLibrary | null>(null)
export const usePictures = (): PictureLibrary | null => useContext(PicturesContext)

type T = (key: string, values?: Record<string, string | number>) => string
const tx = (t: T, key: string, fallback: string): string => { const v = t(key); return v === key ? fallback : v }

export function PictureGrid({ param: p, value, t, labelId, onPick, onUpload }: { param: Extract<ParamDef, { type: 'asset' }>; value: unknown; t: T; labelId: string; onPick: (id: string | null) => void; onUpload: () => void }): ReactElement | null {
  const lib = usePictures()
  const all = lib ? lib.items(p.library) : []
  const cats = useMemo(() => [...new Set(all.map(x => x.category).filter((c): c is string => !!c))], [all])
  const [cat, setCat] = useState<string>('')
  const [q, setQ] = useState('')
  if (!lib) return null
  const shown = all.filter(x => (cat === '' || x.category === cat) && (q === '' || x.name.toLowerCase().includes(q.toLowerCase())))
  const has = value !== null && value !== undefined && value !== ''
  return (
    <div className="am-field" role="group" aria-labelledby={labelId}>
      {all.length > 12 || cats.length > 1 ? (
        <div className="am-row am-picfilter">
          {cats.length > 1 ? (
            <select aria-label={tx(t, 'pictures.category', 'Group')} value={cat} onChange={e => setCat(e.target.value)}>
              <option value="">{tx(t, 'pictures.all', 'All')}</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : null}
          {all.length > 12 && p.searchable !== false ? <input type="search" aria-label={tx(t, 'pictures.search', 'Search')} placeholder={tx(t, 'pictures.search', 'Search')} value={q} onChange={e => setQ(e.target.value)} /> : null}
        </div>
      ) : null}
      <div className="am-pictures">
        {has ? <button type="button" className="am-pic-none" onClick={() => onPick(null)}><span className="am-pic-name">{tx(t, 'pictures.none', 'None')}</span></button> : null}
        {shown.map(x => (
          <button key={x.id} type="button" className="am-pic" aria-pressed={value === x.id} onClick={() => onPick(x.id)} title={x.name}>
            <img src={x.url} alt="" loading="lazy" /><span className="am-pic-name">{x.name}</span>
          </button>
        ))}
        {p.allow_upload !== false ? <button type="button" className="am-pic-upload" onClick={onUpload}><span aria-hidden="true">+</span><span className="am-pic-name">{tx(t, 'pictures.upload', 'Upload…')}</span></button> : null}
      </div>
      {shown.length === 0 && all.length > 0 ? <p className="am-help">{tx(t, 'pictures.noMatch', 'No picture matches.')}</p> : null}
    </div>
  )
}
