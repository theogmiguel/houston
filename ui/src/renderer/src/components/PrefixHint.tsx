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
import { MATERIAL_CLS, materialAttrs } from './material'

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
    <div
      data-testid="prefix-hint"
      role="status"
      {...materialAttrs('overlay-glass')}
      className={`pointer-events-none fixed left-1/2 bottom-6 z-[var(--z-modal)] -translate-x-1/2 w-[640px] max-w-[92vw] rounded-[var(--tr-radius-md)] ${MATERIAL_CLS['overlay-glass']} flex flex-col gap-2 px-4 py-3`}
    >
      <div className="text-accent [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
        {effectiveLabel(prefixShortcut, keymapOverrides)} · next key
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-4 gap-y-2">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <div className="text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase">
              {g.label}
            </div>
            <div>
              {g.rows.map((r) => (
                <div
                  key={r.what}
                  className="flex items-baseline justify-between gap-2 [font-size:var(--tr-text-small-size)] text-text-secondary"
                >
                  <span>{r.what}</span>
                  <span className="flex gap-1">
                    {r.entries.map((s) => (
                      <kbd
                        key={s.id}
                        className="font-mono text-text-primary bg-background border border-border rounded px-1 [font-size:var(--tr-text-small-size)]"
                      >
                        {effectiveLabel(s, keymapOverrides)}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
