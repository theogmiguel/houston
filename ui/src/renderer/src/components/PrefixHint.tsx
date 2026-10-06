import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import {
  effectiveLabel,
  expandPane,
  focusNextPane,
  focusPrevPane,
  gridNext,
  gridPrev,
  movePaneNext,
  movePanePrev,
  newBrowserPane,
  newTerminal,
  openFileShortcut,
  paletteLayer,
  prefixShortcut,
  selectPane,
  shortcutSheetShortcut,
  splitDown,
  splitLeft,
  splitRight,
  splitUp,
  tidyGrid,
  toggleGit,
  wsLast,
  wsNext,
  wsPrev,
  type ShortcutEntry
} from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { PREFIX_HINT_DELAY_MS, prefixLayer } from '../prefixLayer'
import {
  KeyCap,
  KeymapHintGrid,
  KeymapHintGroup,
  KeymapHintHeading,
  KeymapHintRow,
  KeymapHintSurface
} from './ui/KeymapHint'

// What the overlay teaches, grouped the way people think about "where am I going".
// Entries are the keymap's own, so a rebind shows its new chord automatically.
const GROUPS: { label: string; rows: { entries: ShortcutEntry[]; what: string }[] }[] = [
  {
    label: 'Workspace',
    rows: [
      { entries: [wsPrev, wsNext], what: 'previous / next' },
      { entries: [wsLast], what: 'last' }
    ]
  },
  {
    label: 'Grid',
    rows: [
      { entries: [gridPrev, gridNext], what: 'previous / next' },
      { entries: [paletteLayer], what: 'search' }
    ]
  },
  {
    label: 'Pane',
    rows: [
      { entries: [focusPrevPane, focusNextPane], what: 'previous / next' },
      { entries: [selectPane], what: 'by position' },
      { entries: [movePanePrev, movePaneNext], what: 'swap' },
      { entries: [splitRight, splitUp, splitLeft, splitDown], what: 'split' },
      { entries: [expandPane, tidyGrid], what: 'expand / tidy' }
    ]
  },
  {
    label: 'App',
    rows: [
      { entries: [newTerminal, openFileShortcut, newBrowserPane], what: 'terminal / file / browser' },
      { entries: [toggleGit], what: 'source control' },
      { entries: [shortcutSheetShortcut], what: 'all shortcuts' },
      { entries: [prefixShortcut], what: 'send the chord itself' }
    ]
  }
]

function useArmed(): boolean {
  return useSyncExternalStore(prefixLayer.subscribe, prefixLayer.isArmed, prefixLayer.isArmed)
}

export function PrefixHint(): React.JSX.Element | null {
  const armed = useArmed()
  const keymapOverrides = useContext(KeymapOverridesContext)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!armed) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), PREFIX_HINT_DELAY_MS)
    return () => clearTimeout(t)
  }, [armed])

  if (!armed || !shown) return null
  return (
    <KeymapHintSurface data-testid="prefix-hint" role="status">
      <KeymapHintHeading>{effectiveLabel(prefixShortcut, keymapOverrides)} · next key</KeymapHintHeading>
      <KeymapHintGrid>
        {GROUPS.map((g) => (
          <KeymapHintGroup key={g.label} label={g.label}>
            {g.rows.map((r) => (
              <KeymapHintRow key={r.what} what={r.what}>
                {r.entries.map((s) => (
                  <KeyCap key={s.id}>{effectiveLabel(s, keymapOverrides)}</KeyCap>
                ))}
              </KeymapHintRow>
            ))}
          </KeymapHintGroup>
        ))}
      </KeymapHintGrid>
    </KeymapHintSurface>
  )
}
