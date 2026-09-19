import { useContext } from 'react'
import { effectiveLabel, isSwitchGoverned, KEYMAP, type ShortcutCategory } from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { BTN_GHOST } from './buttonChrome'
import { MATERIAL_CLS, materialAttrs } from './material'

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
    <div
      className="pop-backdrop fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay backdrop-blur-sm pt-0 motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)] [.anim-out_&]:motion-safe:animate-[backdrop-out_var(--animate-t-scrim)_var(--animate-ease-scrim)_forwards]"
      onMouseDown={onClose}
    >
      <div
        {...materialAttrs('overlay-glass')}
        className={`pop w-[480px] max-w-[92vw] rounded-[var(--tr-radius-md)] ${MATERIAL_CLS['overlay-glass']} motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-3.5 py-[11px] border-b border-border [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary">
          SHORTCUTS
        </div>
        {!keymapOverrides.shortcuts_enabled && (
          <div className="mx-4 mb-2 px-2.5 py-1.5 rounded-[var(--tr-radius-sm)] bg-danger/12 text-text-secondary [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
            Global shortcuts are OFF (Settings → Shortcuts) — KEYBOARD and IN THE EDITOR rows below
            are inert.
          </div>
        )}
        <div className="p-5 space-y-4">
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
        </div>
        <div className="flex flex-col items-end gap-2 px-5 pb-5">
          <button className={`btn ${BTN_GHOST}`} onClick={onClose}>
            Close <span className="opacity-55 font-normal">esc</span>
          </button>
        </div>
      </div>
    </div>
  )
}
