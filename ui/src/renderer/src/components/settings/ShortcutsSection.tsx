import { useEffect, useState } from 'react'
import {
  chordFromEvent,
  effectiveLabel,
  findConflict,
  isModifierKeydown,
  isSwitchGoverned,
  KEYMAP
} from '../../keymap'
import type { Chord, ShortcutCategory, ShortcutEntry } from '../../keymap'
import type { KeymapOverrides } from '../../houston/client'
import { setPassKeysToTerminal, usePassKeysToTerminal } from '../../paneCaps'
import { Tooltip } from '../ui/Tooltip'
import { Toggle } from '../ui/settingsPrimitives'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { TextInput } from '../ui/TextInput'
import { Row } from './shared'
import { SettingsList } from '../ui/settingsPrimitives'
import { KeyChip } from '../ui/KeyCap'
import { ShortcutGroupLabel } from '../ui/ShortcutGroupLabel'
import { Text } from '../ui/Text'
import { ShortcutBindingRow, ShortcutConflictActions, ShortcutResetSlot, ShortcutToolbar } from '../ui/ShortcutControls'

const SHORTCUT_GROUPS: { category: ShortcutCategory; label: string }[] = [
  { category: 'global', label: 'Global' },
  { category: 'editor', label: 'In the editor' },
  { category: 'terminal', label: 'In a terminal' },
  { category: 'gesture', label: 'Mouse' }
]

interface Conflict {
  forId: string
  ownerId: string | null
  previousChord: Chord | null
  chord: Chord
  message: string
}

function defaultChord(entry: ShortcutEntry): Chord | null {
  if (entry.chord) return entry.chord
  const known: Partial<Record<ShortcutEntry['id'], Chord>> = {
    'zoom-in': { code: 'Equal', ctrl: true, alt: false, shift: false, meta: false },
    'zoom-out': { code: 'Minus', ctrl: true, alt: false, shift: false, meta: false },
    'font-zoom-in': { code: 'Equal', ctrl: true, alt: true, shift: false, meta: false },
    'font-zoom-out': { code: 'Minus', ctrl: true, alt: true, shift: false, meta: false }
  }
  if (known[entry.id]) return known[entry.id]!
  const tokens = entry.keyLabel.split(' / ')[0].replaceAll('−', '-').split('+')
  const key = tokens.pop() || (entry.keyLabel.startsWith('Ctrl+') ? '=' : '')
  const code = key === 'Space' ? 'Space' : key === 'Tab' ? 'Tab' : /^F\d+$/.test(key) ? key
    : /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}`
      : ({ '=': 'Equal', '-': 'Minus', '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '/': 'Slash', '?': 'Slash' } as Record<string, string>)[key] ?? null
  if (!code) return null
  return {
    code,
    ctrl: tokens.includes('Ctrl'),
    alt: tokens.includes('Alt'),
    shift: tokens.includes('Shift') || key === '?',
    meta: tokens.includes('Meta')
  }
}

function ShortcutRow({
  s,
  keymapOverrides,
  armedId,
  conflict,
  onArm,
  onReset,
  onReplace,
  onCancelConflict
}: {
  s: ShortcutEntry
  keymapOverrides: KeymapOverrides
  armedId: string | null
  conflict: Conflict | null
  onArm: (id: string) => void
  onReset: (id: string) => void
  onReplace: (id: string) => void
  onCancelConflict: () => void
}): React.JSX.Element {
  const remappable = s.remappable ?? s.category === 'global'
  const overridden = remappable && s.id in keymapOverrides.bindings
  const inertNow = isSwitchGoverned(s.category) && !keymapOverrides.shortcuts_enabled
  return (
    <ShortcutBindingRow
      data-testid="settings-shortcut-row"
      inert={inertNow}
    >
      {remappable ? (
        <KeyChip
          as="button"
          type="button"
          state={armedId === s.id ? 'armed' : 'idle'}
          size="shortcut"
          onClick={() => onArm(s.id)}
        >
          {armedId === s.id ? 'Press a key… (Esc cancels)' : effectiveLabel(s, keymapOverrides)}
        </KeyChip>
      ) : (
        <Tooltip label="Not remappable">
          <KeyChip size="shortcut">
            {s.keyLabel}
          </KeyChip>
        </Tooltip>
      )}
      <Text className="min-w-0 flex-1" leading="shortcut" size="small" weight="small" tone="muted">
        {s.description}
        {inertNow && (
          <em><Text tone="muted"> — off (shortcuts disabled)</Text></em>
        )}
        {conflict && conflict.forId === s.id && (
          <ShortcutConflictActions>
            <Notice
              tone="warn"
              indicator="dot"
              className="flex-1"
              action={conflict.ownerId && conflict.previousChord ? { label: 'Replace', onClick: () => onReplace(s.id) } : undefined}
            >
              {conflict.message}
            </Notice>
          <Button variant="ghost" size="sm" onClick={onCancelConflict}>Cancel</Button>
          </ShortcutConflictActions>
        )}
      </Text>
      {overridden && (
        <Button
          variant="legacy-ghost"
          size="sm"
          data-testid="settings-row-reset"
          className="flex-none"
          onClick={() => onReset(s.id)}
        >
          Reset
        </Button>
      )}
    </ShortcutBindingRow>
  )
}

function conflictLabel(found: NonNullable<ReturnType<typeof findConflict>>): string {
  if (found.kind === 'terminal') return `${found.entry.keyLabel} (owned by the terminal)`
  if (found.kind === 'editor') return `${found.entry.keyLabel} (owned by the editor pane / file tree)`
  return found.entry.description
}

export interface ShortcutsSectionProps {
  keymapOverrides: KeymapOverrides
  onKeymapOverrides: (overrides: KeymapOverrides) => void
}

export function ShortcutsSection({
  keymapOverrides,
  onKeymapOverrides
}: ShortcutsSectionProps): React.JSX.Element {
  const passThrough = usePassKeysToTerminal()
  const [armedId, setArmedId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (armedId === null) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setArmedId(null)
        return
      }
      if (isModifierKeydown(e)) return
      if (armedId === 'select-pane' && !(e.key >= '1' && e.key <= '9')) {
        setConflict({
          forId: armedId,
          ownerId: null,
          previousChord: null,
          chord: chordFromEvent(e),
          message: 'select-pane only binds modifiers + a digit 1-9 — press a modifier with 1-9'
        })
        setArmedId(null)
        return
      }
      const found = findConflict(armedId, e, keymapOverrides)
      if (found) {
        const target = KEYMAP.find((entry) => entry.id === armedId)
        const previousChord = target ? keymapOverrides.bindings[armedId] ?? defaultChord(target) : null
        const ownerChord = keymapOverrides.bindings[found.entry.id] ?? defaultChord(found.entry)
        setConflict({
          forId: armedId,
          ownerId: ownerChord && previousChord ? found.entry.id : null,
          previousChord,
          chord: chordFromEvent(e),
          message: `Conflicts with ${conflictLabel(found)}.`
        })
        setArmedId(null)
        return
      }
      setConflict(null)
      onKeymapOverrides({
        ...keymapOverrides,
        bindings: { ...keymapOverrides.bindings, [armedId]: chordFromEvent(e) }
      })
      setArmedId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armedId, keymapOverrides, onKeymapOverrides])

  const resetBinding = (id: string): KeymapOverrides['bindings'] => {
    const bindings = { ...keymapOverrides.bindings }
    delete bindings[id]
    return bindings
  }

  const replaceBinding = (id: string): void => {
    if (!conflict || conflict.forId !== id || !conflict.ownerId) return
    const bindings = { ...keymapOverrides.bindings, [id]: conflict.chord }
    if (conflict.previousChord) bindings[conflict.ownerId] = conflict.previousChord
    setConflict(null)
    onKeymapOverrides({ ...keymapOverrides, bindings })
  }

  return (
    <>
      <SettingsList>
        <Row
          title="Enable shortcuts"
          desc="Turns off the shortcuts below and the editor pane's own keys. Esc stays live."
        >
          <Toggle
            on={keymapOverrides.shortcuts_enabled}
            onChange={(on) => onKeymapOverrides({ ...keymapOverrides, shortcuts_enabled: on })}
          />
        </Row>
        <Row
          title="Pass through to terminal"
          desc="A focused pane gets Houston's remappable chords, except the prefix key. Copy and find still belong to Houston."
        >
          <Toggle
            on={passThrough}
            data-testid="settings-pass-through"
            onChange={setPassKeysToTerminal}
          />
        </Row>
      </SettingsList>
      <ShortcutToolbar>
        <TextInput
          type="search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          data-testid="settings-shortcuts-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1"
        />
        <ShortcutResetSlot>
        <Button
          variant="legacy-ghost"
          disabled={Object.keys(keymapOverrides.bindings).length === 0}
          onClick={() => {
            setArmedId(null)
            setConflict(null)
            onKeymapOverrides({ ...keymapOverrides, bindings: {} })
          }}
        >
          Reset all to defaults
        </Button>
        </ShortcutResetSlot>
      </ShortcutToolbar>
      <SettingsList>
        {SHORTCUT_GROUPS.map(({ category, label }) => {
          const needle = query.trim().toLocaleLowerCase()
          const rows = KEYMAP.filter((s) => s.category === category && (!needle || `${s.description} ${s.keyLabel} ${s.id}`.toLocaleLowerCase().includes(needle)))
          if (rows.length === 0) return null
          return (
            <div key={category} data-testid="settings-shortcut-group">
              <ShortcutGroupLabel testId="settings-shortcut-group-label">{label}</ShortcutGroupLabel>
              {rows.map((s) => (
                <ShortcutRow
                  key={s.id}
                  s={s}
                  keymapOverrides={keymapOverrides}
                  armedId={armedId}
                  conflict={conflict}
                  onReplace={replaceBinding}
                  onCancelConflict={() => setConflict(null)}
                  onArm={(id) => {
                    setConflict(null)
                    setArmedId((cur) => (cur === id ? null : id))
                  }}
                  onReset={(id) => onKeymapOverrides({ ...keymapOverrides, bindings: resetBinding(id) })}
                />
              ))}
            </div>
          )
        })}
      </SettingsList>
    </>
  )
}
