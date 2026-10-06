import { useEffect, useRef, useState } from 'react'
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
    <Stack data-testid="appearance-picker" onKeyDown={onKeyDown}>
      <Stack axis="horizontal" space="compact">
        <PaletteSearch value={query} onChange={(e) => setQuery(e.target.value)} />
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
      </Stack>

      {visible.length === 0 ? (
        <EmptyMessage>
          No palettes match &quot;{query}&quot;
        </EmptyMessage>
      ) : (
        <PaletteOptionList>
          {visible.map((t) => {
            const selected = t === highlighted
            const palette = TERMINAL_PALETTES[t]
            return <PaletteOptionRow
              key={t}
              selected={selected}
              label={THEME_LABELS[t] ?? t}
              color={palette.background ?? "transparent"}
              onHover={() => highlight(t)}
              onSelect={() => commit(t)}
            />
          })}
        </PaletteOptionList>
      )}
    </Stack>
  )
}
