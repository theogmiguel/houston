import { useEffect, useState } from 'react'
import { BTN_GHOST } from '../buttonChrome'
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
import { Tooltip } from '../Tooltip'
import { Toggle } from '../settingsPrimitives'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { TextInput } from '../ui/TextInput'
import { Row } from './shared'

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
    <div
      data-testid="settings-shortcut-row"
      data-inert={inertNow || undefined}
      className={`flex items-start gap-[10px] py-[8px] px-[14px] [&+&]:border-t [&+&]:border-t-[var(--divider)] ${inertNow ? '[&_.key-chip]:opacity-45' : ''}`}
    >
      {remappable ? (
        <button
          type="button"
          className={`btn key-chip key-chip--capture flex-none min-w-[118px] font-semibold bg-[var(--content-bg)] border rounded-[var(--tr-radius-input)] py-px px-[7px] justify-center text-center [font-size:var(--tr-text-small-size)] font-mono ${
            armedId === s.id
              ? 'armed border-[var(--accent,var(--text-primary))] text-[var(--text-primary)]'
              : 'border-transparent hover:border-[var(--border)] text-[var(--text-muted)]'
          }`}
          onClick={() => onArm(s.id)}
        >
          {armedId === s.id ? 'Press a key… (Esc cancels)' : effectiveLabel(s, keymapOverrides)}
        </button>
      ) : (
        <Tooltip label="Not remappable">
          <span
            className="key-chip key-chip--fixed flex-none min-w-[118px] font-semibold bg-[var(--content-bg)] border border-[var(--border)] rounded-sm py-px px-[7px] text-center [font-size:var(--tr-text-small-size)] font-mono text-[var(--text-muted)] opacity-60"
          >
            {s.keyLabel}
          </span>
        </Tooltip>
      )}
      <span className="min-w-0 flex-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.45] text-[var(--text-muted)]">
        {s.description}
        {inertNow && (
          <span className="text-[var(--text-muted)] italic"> — off (shortcuts disabled)</span>
        )}
        {conflict && conflict.forId === s.id && (
          <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <Notice
              tone="warn"
              indicator="dot"
              className="flex-1"
              action={conflict.ownerId && conflict.previousChord ? { label: 'Replace', onClick: () => onReplace(s.id) } : undefined}
            >
              {conflict.message}
            </Notice>
            <Button variant="ghost" size="sm" onClick={onCancelConflict}>Cancel</Button>
          </div>
        )}
      </span>
      {overridden && (
        <button
          type="button"
          data-testid="settings-row-reset"
          className={`btn ${BTN_GHOST} flex-none`}
          onClick={() => onReset(s.id)}
        >
          Reset
        </button>
      )}
    </div>
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
      <div className="">
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
      </div>
      <div className="flex items-center justify-between gap-[var(--space-3)] py-[var(--space-3)]">
        <TextInput
          type="search"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts…"
          data-testid="settings-shortcuts-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1"
        />
        <div className="pt-2 mb-[var(--space-5)]">
        <button
          type="button"
          className={`btn ${BTN_GHOST}`}
          disabled={Object.keys(keymapOverrides.bindings).length === 0}
          onClick={() => {
            setArmedId(null)
            setConflict(null)
            onKeymapOverrides({ ...keymapOverrides, bindings: {} })
          }}
        >
          Reset all to defaults
        </button>
        </div>
      </div>
      <div className="">
        {SHORTCUT_GROUPS.map(({ category, label }) => {
          const needle = query.trim().toLocaleLowerCase()
          const rows = KEYMAP.filter((s) => s.category === category && (!needle || `${s.description} ${s.keyLabel} ${s.id}`.toLocaleLowerCase().includes(needle)))
          if (rows.length === 0) return null
          return (
            <div key={category} data-testid="settings-shortcut-group">
              <div
                className="px-3 py-[6px] [font-size:var(--tr-text-label-size)] font-semibold uppercase tracking-[0.04em] text-[var(--text-muted)] bg-[var(--content-bg)] border-b border-[var(--divider)]"
                data-testid="settings-shortcut-group-label"
              >
                {label}
              </div>
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
      </div>
    </>
  )
}
