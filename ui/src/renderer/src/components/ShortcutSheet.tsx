import { useContext } from 'react'
import { effectiveLabel, isSwitchGoverned, KEYMAP, type ShortcutCategory } from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from './ui'

interface Props {
  onClose: () => void
}

const SECTIONS: { category: ShortcutCategory; label: string }[] = [
  { category: 'global', label: 'KEYBOARD' },
  { category: 'terminal', label: 'IN THE TERMINAL' },
  { category: 'editor', label: 'IN THE EDITOR' },
  { category: 'gesture', label: 'MOUSE' }
]

export function ShortcutSheet({ onClose }: Props): React.JSX.Element {
  const keymapOverrides = useContext(KeymapOverridesContext)
  return (
    <DialogBackdrop onMouseDown={onClose}>
      <DialogPanel size="wide" surface="glass" onMouseDown={(e) => e.stopPropagation()}>
        <DialogTitle>SHORTCUTS</DialogTitle>
        {!keymapOverrides.shortcuts_enabled && (
          <div className="mx-4 mb-2 px-2.5 py-1.5 rounded-[var(--tr-radius-sm)] bg-danger/12 text-text-secondary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
            Global shortcuts are OFF (Settings → Shortcuts) — KEYBOARD and IN THE EDITOR rows below
            are inert.
          </div>
        )}
        <DialogBody>
          {SECTIONS.map(({ category, label }) => {
            const items = KEYMAP.filter((s) => s.category === category)
            if (items.length === 0) return null
            const inert = isSwitchGoverned(category) && !keymapOverrides.shortcuts_enabled
            return (
              <div key={category}>
                <label className="block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase mb-[5px]">
                  {label}
                </label>
                <div className="flex flex-col gap-1 overflow-y-auto">
                  {items.map((s) => (
                    <div
                      key={s.id}
                      className={`flex gap-2.5 items-baseline [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] ${inert ? 'opacity-[0.45]' : ''}`}
                    >
                      <span className="flex-none min-w-[118px] text-text-muted font-semibold bg-background border border-border rounded px-1.75 py-px text-center [font-size:var(--tr-text-small-size)]">
                        {effectiveLabel(s, keymapOverrides)}
                      </span>
                      <span className="text-text-secondary">{s.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </DialogBody>
        <DialogActions>
          <Button variant="legacy-ghost" onClick={onClose}>Close <span className="opacity-55 font-normal">esc</span></Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
