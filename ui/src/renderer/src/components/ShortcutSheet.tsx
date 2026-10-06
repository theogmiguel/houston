import { useContext } from 'react'
import { effectiveLabel, isSwitchGoverned, KEYMAP, type ShortcutCategory } from '../keymap'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { Button, DialogActions, DialogAlert, DialogBackdrop, DialogBody, DialogPanel, DialogTitle, KeyBindingRow, Stack, Text } from './ui'

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
          <DialogAlert>
            Global shortcuts are OFF (Settings → Shortcuts) — KEYBOARD and IN THE EDITOR rows below
            are inert.
          </DialogAlert>
        )}
        <DialogBody>
          {SECTIONS.map(({ category, label }) => {
            const items = KEYMAP.filter((s) => s.category === category)
            if (items.length === 0) return null
            const inert = isSwitchGoverned(category) && !keymapOverrides.shortcuts_enabled
            return (
              <Stack key={category} gap="field">
                <Text as="label" size="label" weight="label" tone="muted">
                  {label}
                </Text>
                <Stack gap={1} className="overflow-y-auto">
                  {items.map((s) => (
                    <KeyBindingRow key={s.id} keyName={effectiveLabel(s, keymapOverrides)} description={s.description} disabled={inert} />
                  ))}
                </Stack>
              </Stack>
            )
          })}
        </DialogBody>
        <DialogActions>
          <Button variant="legacy-ghost" onClick={onClose}>Close <Text tone="key-hint" weight="medium">esc</Text></Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
