import { useEffect, useId, useRef, useState } from 'react'
import {
  THEMES,
  THEME_LABELS,
  THEME_DESCRIPTIONS,
  THEME_MODES,
  TERMINAL_PALETTES,
  type ThemeMode,
  type ThemeName
} from '../theme'
import { Segmented } from './ui/SegmentedControl'
import { EmptyMessage, PaletteOptionList, PaletteOptionRow, PaletteSearch } from './ui/PaletteOptions'
import { Stack } from './ui/Stack'

export interface AppearancePickerProps {
  currentTheme: ThemeName
  onPreview: (theme: ThemeName) => void
  onCommit: (theme: ThemeName) => void
}

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
  const [highlighted, setHighlighted] = useState(() => Math.max(0, THEMES.indexOf(currentTheme)))
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const filterThemes = (search: string, mode: 'all' | ThemeMode): ThemeName[] => {
    const needle = search.trim().toLowerCase()
    return THEMES.filter((t) => (mode === 'all' || THEME_MODES[t] === mode) && (
      !needle || THEME_LABELS[t].toLowerCase().includes(needle) ||
      t.toLowerCase().includes(needle) || THEME_DESCRIPTIONS[t].toLowerCase().includes(needle)
    ))
  }
  const visible = filterThemes(query, tab)
  const activeTheme = visible[highlighted]

  const highlight = (index: number): void => {
    const theme = visible[index]
    if (!theme) return
    setHighlighted(index)
    onPreview(theme)
  }

  const filter = (search: string, mode: 'all' | ThemeMode): void => {
    setQuery(search)
    setTab(mode)
    setHighlighted(0)
    const first = filterThemes(search, mode)[0]
    if (first) onPreview(first)
    searchRef.current?.focus()
  }

  useEffect(() => {
    if (!activeTheme) return
    document.getElementById(`${listId}-${activeTheme}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeTheme, listId])

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
    if (e.target !== searchRef.current) return
    if (e.key === 'Escape') {
      e.preventDefault()
      restoreOriginal()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (activeTheme) commit(activeTheme)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (visible.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      highlight((highlighted + delta + visible.length) % visible.length)
    }
  }

  return (
    <Stack data-testid="appearance-picker" gap={3} onKeyDown={onKeyDown}>
      <Stack axis="horizontal" align="center" gap={2}>
        <PaletteSearch ref={searchRef} autoFocus value={query} onChange={(e) => filter(e.target.value, tab)} role="combobox" aria-autocomplete="list" aria-expanded={visible.length > 0} aria-controls={visible.length ? listId : undefined} aria-activedescendant={activeTheme ? `${listId}-${activeTheme}` : undefined} />
        <Segmented
          aria-label="Filter palettes by mode"
          options={[
            { value: 'all', label: 'All' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' }
          ]}
          value={tab}
          onChange={(mode) => filter(query, mode)}
        />
      </Stack>

      {visible.length === 0 ? (
        <EmptyMessage>
          No palettes match &quot;{query}&quot;
        </EmptyMessage>
      ) : (
        <PaletteOptionList id={listId}>
          {visible.map((t, index) => {
            const selected = t === originalRef.current
            const palette = TERMINAL_PALETTES[t]
            return <PaletteOptionRow
              key={t}
              selected={selected}
              highlighted={index === highlighted}
              id={`${listId}-${t}`}
              label={THEME_LABELS[t] ?? t}
              color={palette.background ?? "transparent"}
              onHover={() => highlight(index)}
              onSelect={() => commit(t)}
            />
          })}
        </PaletteOptionList>
      )}
    </Stack>
  )
}
