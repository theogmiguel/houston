import { useEffect, useRef, useState } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import {
  THEMES,
  THEME_LABELS,
  THEME_DESCRIPTIONS,
  THEME_MODES,
  TERMINAL_PALETTES,
  type ThemeMode,
  type ThemeName
} from '../theme'
import { Segmented } from './Segmented'
import { IconCheck, IconSearch } from './icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export interface AppearancePickerProps {
  currentTheme: ThemeName
  onPreview: (theme: ThemeName) => void
  onCommit: (theme: ThemeName) => void
}

const LIST_MAX_HEIGHT = 320

export function AppearancePicker({
  currentTheme,
  onPreview,
  onCommit
}: AppearancePickerProps): React.JSX.Element {
  const originalRef = useRef(currentTheme)
  const committedRef = useRef(false)
  const restoredRef = useRef(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'all' | ThemeMode>('all')
  const [highlighted, setHighlighted] = useState<ThemeName>(currentTheme)

  const queryNorm = query.trim().toLowerCase()
  const matching = THEMES.filter((t) => {
    if (!queryNorm) return true
    return (
      THEME_LABELS[t].toLowerCase().includes(queryNorm) ||
      t.toLowerCase().includes(queryNorm) ||
      THEME_DESCRIPTIONS[t].toLowerCase().includes(queryNorm)
    )
  })
  const visible = matching.filter((t) => tab === 'all' || THEME_MODES[t] === tab)

  const highlight = (t: ThemeName): void => {
    setHighlighted(t)
    onPreview(t)
  }

  const restoreOriginal = (): void => {
    if (committedRef.current || restoredRef.current) return
    restoredRef.current = true
    onPreview(originalRef.current)
  }

  const commit = (t: ThemeName): void => {
    committedRef.current = true
    onCommit(t)
  }

  // Deliberately mount-only: `onPreview` is expected to be a stable callback, and
  // this restore must run exactly once, when the picker unmounts.
  useEffect(() => {
    return () => {
      if (!committedRef.current && !restoredRef.current) {
        onPreview(originalRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      restoreOriginal()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(highlighted)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (visible.length === 0) return
      const idx = visible.indexOf(highlighted)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = visible[(idx + delta + visible.length) % visible.length] ?? visible[0]
      highlight(next)
    }
  }

  return (
    <div data-testid="appearance-picker" onKeyDown={onKeyDown} className="flex flex-col gap-[var(--space-3)]">
      <div className="flex items-center gap-[var(--space-2)]">
        <div className="relative flex-1 min-w-0">
          <span aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
            <Icon glyph={IconSearch} role="small" />
          </span>
          <input
            type="search"
            data-testid="appearance-picker-search"
            aria-label="Search palettes"
            placeholder="Search palettes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`w-full h-[var(--h-ctl)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--tr-radius-button)] pl-7 pr-2 text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`}
          />
        </div>
        <Segmented
          aria-label="Filter palettes by mode"
          options={[
            { value: 'all', label: 'All' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' }
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {visible.length === 0 ? (
        <div
          data-testid="appearance-picker-empty-set"
          className="py-[var(--space-5)] text-center text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]"
        >
          No palettes match &quot;{query}&quot;
        </div>
      ) : (
        <div
          data-testid="appearance-picker-list"
          role="listbox"
          aria-label="Terminal palettes"
          className="flex flex-col gap-[2px] overflow-y-auto"
          style={{ maxHeight: LIST_MAX_HEIGHT }}
        >
          {visible.map((t) => {
            const selected = t === highlighted
            const palette = TERMINAL_PALETTES[t]
            return (
              <button
                key={t}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid="appearance-picker-row"
                onMouseEnter={() => highlight(t)}
                onClick={() => commit(t)}
                className={`border-0 flex items-center gap-[var(--space-2-5)] h-[var(--h-row)] px-[var(--space-2-5)] rounded-[var(--tr-radius-sm)] text-left text-[length:var(--tr-text-ui-size)] hover:bg-[var(--surface-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${
                  selected ? 'bg-[var(--accent-muted)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'
                }`}
              >
                <span
                  aria-hidden
                  className="flex-none h-[14px] w-[14px] rounded-[3px] border border-[var(--border)]"
                  style={{ background: palette.background }}
                />
                <Tooltip label={THEME_LABELS[t]}>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {THEME_LABELS[t]}
                  </span>
                </Tooltip>
                {selected && (
                  <span aria-hidden>
                    <Icon glyph={IconCheck} role="small" />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
