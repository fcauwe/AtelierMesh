// The step title in the settings header with a pencil next to it: click it to rename the step (Enter or leaving the field saves, Escape cancels).
// An empty name goes back to the type's own title. The words "Step 2 ·" in front are not part of the name.
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { T } from './common'
import { tx } from './common'

export interface EditableTitleProps { t: T; prefix: string; name: string; defaultName: string; onRename: (name: string) => void }

export function EditableTitle({ t, prefix, name, defaultName, onRename }: EditableTitleProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  const pencil = useRef<HTMLButtonElement>(null)
  const cancelled = useRef(false)
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select() } }, [editing])
  const label = tx(t, 'step.rename', 'Rename this step')
  const done = (save: boolean): void => {
    setEditing(false)
    if (save) onRename(draft.trim() === defaultName ? '' : draft.trim())
    pencil.current?.focus()
  }
  if (editing) {
    return (
      <div className="am-title am-title-edit">
        <span className="am-stepno">{prefix} · </span>
        <input ref={input} type="text" maxLength={80} value={draft} placeholder={defaultName} aria-label={tx(t, 'step.name', 'Name')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); cancelled.current = false; done(true) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; done(false) } }}
          onBlur={() => { if (cancelled.current) { cancelled.current = false; return } if (editing) done(true) }} />
      </div>
    )
  }
  return (
    <h2 className="am-title">
      <span className="am-stepno">{prefix} · </span>{name || defaultName}
      <button ref={pencil} type="button" className="am-pencil" aria-label={label} title={label} onClick={() => { setDraft(name || defaultName); setEditing(true) }}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
      </button>
    </h2>
  )
}
