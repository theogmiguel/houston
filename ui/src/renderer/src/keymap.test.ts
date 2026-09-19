import { describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  chordLabel,
  commandPaletteShortcut,
  dictationShortcut,
  effectiveLabel,
  endsDictationHold,
  findConflict,
  GLOBAL_SHORTCUTS,
  isDictationChord,
  isModifierKeydown,
  KEYMAP,
  newTerminal,
  resolveMatch,
  selectPane,
  toggleSidebar,
  zoomIn,
  splitSideFor
} from './keymap'
import type { KeymapOverrides } from './houston/generated/KeymapOverrides'

function fakeKey(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods } as KeyboardEvent
}

function fakeChord(c: {
  code: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}): KeyboardEvent {
  return {
    key: '',
    code: c.code,
    ctrlKey: c.ctrl ?? false,
    altKey: c.alt ?? false,
    shiftKey: c.shift ?? false,
    metaKey: c.meta ?? false
  } as KeyboardEvent
}

describe('KEYMAP', () => {
  it('every entry has id/keyLabel/description', () => {
    for (const s of KEYMAP) {
      expect(s.id, 'id').toBeTruthy()
      expect(s.keyLabel, `${s.id} keyLabel`).toBeTruthy()
      expect(s.description, `${s.id} description`).toBeTruthy()
    }
  })

  it('has unique ids', () => {
    const ids = KEYMAP.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only "global" entries carry a match function', () => {
    for (const s of KEYMAP) {
      if (s.category === 'global') expect(s.match).toBeTypeOf('function')
      else expect(s.match).toBeUndefined()
    }
  })

  it('has no stale n-for-new-session entry', () => {
    const matchesN = GLOBAL_SHORTCUTS.some((s) => s.match?.(fakeKey('n')))
    expect(matchesN).toBe(false)
    const staleRow = KEYMAP.some(
      (s) => s.keyLabel.trim().toLowerCase() === 'n' && /new session/i.test(s.description)
    )
    expect(staleRow).toBe(false)
  })

  it('maps t to new terminal', () => {
    expect(newTerminal.match?.(fakeKey('t'))).toBe(true)
    expect(newTerminal.match?.(fakeKey('T'))).toBe(false)
  })

  it('maps Ctrl+K to the command palette, and only Ctrl+K', () => {
    expect(commandPaletteShortcut.match?.(fakeKey('k', { ctrlKey: true }))).toBe(true)
    expect(commandPaletteShortcut.match?.(fakeKey('K', { ctrlKey: true }))).toBe(true)
    expect(commandPaletteShortcut.match?.(fakeKey('k'))).toBe(false)
    expect(commandPaletteShortcut.match?.(fakeKey('k', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(commandPaletteShortcut.match?.(fakeKey('k', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(GLOBAL_SHORTCUTS).toContain(commandPaletteShortcut)
  })

  it('exactly the entries with a swallowing handler carry a chord', () => {
    const chordCarriers = KEYMAP.filter((s) => s.chord).map((s) => s.id).sort()
    expect(chordCarriers).toEqual(
      [
        'term-copy',
        'term-copy-force',
        'term-find',
        'term-paste',
        'split-editor-down',
        'voice-dictate'
      ].sort()
    )
  })
})

describe('splitSideFor', () => {
  const keyEvent = (key: string): KeyboardEvent => ({ key }) as KeyboardEvent

  it('names the side for each of the four WASD keys', () => {
    expect(splitSideFor(keyEvent('d'), noOverrides)).toBe('right')
    expect(splitSideFor(keyEvent('s'), noOverrides)).toBe('bottom')
    expect(splitSideFor(keyEvent('a'), noOverrides)).toBe('left')
    expect(splitSideFor(keyEvent('w'), noOverrides)).toBe('top')
  })

  it('is null for a key that is not a split chord', () => {
    expect(splitSideFor(keyEvent('z'), noOverrides)).toBeNull()
    expect(splitSideFor(keyEvent('q'), noOverrides)).toBeNull()
  })

  it('is null for every key when shortcuts are disabled', () => {
    const off: KeymapOverrides = { bindings: {}, shortcuts_enabled: false }
    for (const k of ['d', 's', 'a', 'w']) expect(splitSideFor(keyEvent(k), off)).toBeNull()
  })
})

const noOverrides: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }

describe('dictation chord remapping (v56)', () => {
  const alt = { code: 'KeyD', ctrl: true, alt: true, shift: false, meta: false }
  const remapped: KeymapOverrides = {
    bindings: { 'voice-dictate': alt },
    shortcuts_enabled: true
  }

  it('is the only remappable terminal entry', () => {
    const remappables = KEYMAP.filter((s) => s.remappable).map((s) => s.id)
    expect(remappables).toEqual(['voice-dictate'])
    expect(dictationShortcut.category).toBe('terminal')
  })

  it('matches the default chord when nothing is bound', () => {
    expect(isDictationChord(fakeChord({ code: 'Space', ctrl: true, shift: true }))).toBe(true)
    expect(isDictationChord(fakeChord({ code: 'KeyD', ctrl: true, alt: true }))).toBe(false)
  })

  it('follows the override once one is stored, and drops the default', () => {
    expect(isDictationChord(fakeChord({ code: 'KeyD', ctrl: true, alt: true }), remapped)).toBe(true)
    expect(
      isDictationChord(fakeChord({ code: 'Space', ctrl: true, shift: true }), remapped),
      'the old chord must stop dictating, or it is bound twice'
    ).toBe(false)
  })

  it('ends the hold on any key of the REMAPPED chord', () => {
    expect(endsDictationHold(fakeChord({ code: 'KeyD' }), remapped)).toBe(true)
    expect(endsDictationHold({ ...fakeChord({ code: 'ControlLeft' }), key: 'Control' } as KeyboardEvent, remapped)).toBe(true)
    expect(endsDictationHold({ ...fakeChord({ code: 'AltLeft' }), key: 'Alt' } as KeyboardEvent, remapped)).toBe(true)
    expect(endsDictationHold({ ...fakeChord({ code: 'ShiftLeft' }), key: 'Shift' } as KeyboardEvent, remapped)).toBe(false)
  })

  it('does not report a conflict with itself when rebound to the key it already has', () => {
    const onto = fakeChord({ code: 'Space', ctrl: true, shift: true })
    expect(findConflict('voice-dictate', onto, noOverrides)).toBeNull()
  })

  it('reserves its REMAPPED chord against other shortcuts, not its old one', () => {
    const conflict = findConflict('toggle-sidebar', fakeChord({ code: 'KeyD', ctrl: true, alt: true }), remapped)
    expect(conflict?.entry.id).toBe('voice-dictate')
    expect(
      findConflict('toggle-sidebar', fakeChord({ code: 'Space', ctrl: true, shift: true }), remapped)
    ).toBeNull()
  })
})

describe('resolveMatch (P4 #16)', () => {
  it('falls back to the built-in matcher when no override exists', () => {
    const match = resolveMatch(toggleSidebar, noOverrides)
    expect(match(fakeKey('b', { ctrlKey: true }))).toBe(true)
    expect(match(fakeKey('x', { ctrlKey: true }))).toBe(false)
  })

  it('an override replaces the built-in matcher entirely — old chord stops matching', () => {
    const overrides: KeymapOverrides = {
      bindings: { 'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false } },
      shortcuts_enabled: true
    }
    const match = resolveMatch(toggleSidebar, overrides)
    expect(match(fakeKey('j', { code: 'KeyJ', ctrlKey: true }))).toBe(true)
    expect(match(fakeKey('b', { code: 'KeyB', ctrlKey: true }))).toBe(false)
  })

  it('matches by code + modifiers, not by .key (layout independence)', () => {
    const overrides: KeymapOverrides = {
      bindings: { 'toggle-sidebar': { code: 'Equal', ctrl: true, alt: false, shift: false, meta: false } },
      shortcuts_enabled: true
    }
    const match = resolveMatch(toggleSidebar, overrides)
    expect(match(fakeKey('unrelated-key-value', { code: 'Equal', ctrlKey: true }))).toBe(true)
  })
})

describe('isModifierKeydown (P4 #16)', () => {
  it('is true for a bare modifier keydown, false for a real chord', () => {
    expect(isModifierKeydown(fakeKey('Control'))).toBe(true)
    expect(isModifierKeydown(fakeKey('Alt'))).toBe(true)
    expect(isModifierKeydown(fakeKey('Shift'))).toBe(true)
    expect(isModifierKeydown(fakeKey('Meta'))).toBe(true)
    expect(isModifierKeydown(fakeKey('j', { ctrlKey: true }))).toBe(false)
  })
})

describe('resolveMatch / select-pane override (P4 #16, finding 2)', () => {
  const overrides: KeymapOverrides = {
    bindings: { 'select-pane': { code: 'KeyB', ctrl: true, alt: false, shift: false, meta: false } },
    shortcuts_enabled: true
  }

  it('fires for every digit 1-9 sharing the captured modifiers, not just the captured code', () => {
    const match = resolveMatch(selectPane, overrides)
    for (const digit of '123456789') {
      expect(match(fakeKey(digit, { ctrlKey: true })), `digit ${digit}`).toBe(true)
    }
  })

  it('does not fire for the literal captured code alone (KeyB) without a digit', () => {
    const match = resolveMatch(selectPane, overrides)
    expect(match(fakeKey('b', { code: 'KeyB', ctrlKey: true }))).toBe(false)
  })

  it('does not fire for a digit missing the captured modifier', () => {
    const match = resolveMatch(selectPane, overrides)
    expect(match(fakeKey('5'))).toBe(false)
  })
})

describe('effectiveLabel / select-pane (P4 #16, finding 2)', () => {
  it('renders "<mods>+1–9", never the captured digit/code', () => {
    const overrides: KeymapOverrides = {
      bindings: { 'select-pane': { code: 'KeyB', ctrl: true, alt: true, shift: false, meta: false } },
      shortcuts_enabled: true
    }
    expect(effectiveLabel(selectPane, overrides)).toBe('Ctrl+Alt+1–9')
  })

  it('falls back to the built-in "1–9" label when unset', () => {
    expect(effectiveLabel(selectPane, noOverrides)).toBe(selectPane.keyLabel)
  })
})

describe('effectiveLabel (P4 #16)', () => {
  it('shows the built-in keyLabel when unset', () => {
    expect(effectiveLabel(toggleSidebar, noOverrides)).toBe(toggleSidebar.keyLabel)
  })

  it('shows the override chord once one is set — the ShortcutSheet-drift bug this exists to prevent', () => {
    const overrides: KeymapOverrides = {
      bindings: { 'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: true, shift: false, meta: false } },
      shortcuts_enabled: true
    }
    expect(effectiveLabel(toggleSidebar, overrides)).toBe('Ctrl+Alt+J')
  })
})

describe('chordFromEvent / chordLabel (P4 #16)', () => {
  it('round-trips a captured event into a chord and back into a label', () => {
    const e = fakeKey('z', { code: 'KeyZ', ctrlKey: true, shiftKey: true })
    const chord = chordFromEvent(e)
    expect(chord).toEqual({ code: 'KeyZ', ctrl: true, alt: false, shift: true, meta: false })
    expect(chordLabel(chord)).toBe('Ctrl+Shift+Z')
  })
})

describe('findConflict (P4 #16)', () => {
  it('flags a chord already bound to another global shortcut', () => {
    const e = fakeKey('b', { code: 'KeyB', ctrlKey: true })
    const conflict = findConflict('zoom-in', e, noOverrides)
    expect(conflict).toEqual({ kind: 'shortcut', entry: toggleSidebar })
  })

  it('flags a chord reserved by a fixed terminal entry (Ctrl+F)', () => {
    const e = fakeKey('f', { code: 'KeyF', ctrlKey: true })
    const conflict = findConflict('zoom-in', e, noOverrides)
    expect(conflict?.kind).toBe('terminal')
    expect(conflict?.entry.id).toBe('term-find')
  })

  it('returns null for a chord nothing has claimed', () => {
    const e = fakeKey('j', { code: 'KeyJ', ctrlKey: true, shiftKey: true })
    expect(findConflict('zoom-in', e, noOverrides)).toBeNull()
  })

  it('does not flag an entry against itself', () => {
    const e = fakeKey('unused', { code: 'Equal', ctrlKey: true })
    expect(zoomIn.id).toBe('zoom-in')
    expect(findConflict('zoom-in', e, noOverrides)).toBeNull()
  })
})
