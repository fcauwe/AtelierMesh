// Light and dark: follows the system until the user picks one, then remembers the choice. It sets `data-theme` on <html>, which theme.css reads.
import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Icon } from './icons'
import type { T } from './common'
import { tx } from './common'

export type ThemeMode = 'light' | 'dark'
const KEY = 'am.theme'
const system = (): ThemeMode => (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
const stored = (): ThemeMode | null => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null } catch { return null } }

export function useTheme(): { mode: ThemeMode; toggle: () => void } {
  const [choice, setChoice] = useState<ThemeMode | null>(stored)
  const [os, setOs] = useState<ThemeMode>(system)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia('(prefers-color-scheme: dark)'), f = (): void => setOs(m.matches ? 'dark' : 'light')
    m.addEventListener('change', f); return () => m.removeEventListener('change', f)
  }, [])
  const mode = choice ?? os
  useEffect(() => { document.documentElement.dataset['theme'] = mode }, [mode])
  const toggle = useCallback((): void => { const next: ThemeMode = mode === 'dark' ? 'light' : 'dark'; setChoice(next); try { localStorage.setItem(KEY, next) } catch { /* private window */ } }, [mode])
  return { mode, toggle }
}

/** The moon (or the sun, in the dark theme) in the top bar. */
export function ThemeToggle({ t, mode, onToggle }: { t: T; mode: ThemeMode; onToggle: () => void }): ReactElement {
  const label = tx(t, 'theme.toggle', 'Switch between light and dark')
  return <button type="button" className="am-ib am-theme" aria-label={label} title={label} aria-pressed={mode === 'dark'} onClick={onToggle}><Icon name={mode === 'dark' ? 'sun' : 'moon'} /></button>
}
