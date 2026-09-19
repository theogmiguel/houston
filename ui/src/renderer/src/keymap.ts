import type { KeyChord } from './houston/generated/KeyChord'
import type { KeymapOverrides } from './houston/generated/KeymapOverrides'
import type { SplitSide } from './layout/tree'

export type ShortcutCategory = 'global' | 'terminal' | 'gesture' | 'editor'

export function isSwitchGoverned(category: ShortcutCategory): boolean {
  return category === 'global' || category === 'editor'
}

export type Chord = KeyChord

export interface ShortcutEntry {
  id: string
  keyLabel: string
  description: string
  category: ShortcutCategory
  match?: (e: KeyboardEvent) => boolean
  chord?: Chord
  remappable?: boolean
}

export const escapeShortcut: ShortcutEntry = {
  id: 'escape',
  keyLabel: 'Esc',
  description: 'close dialogs / collapse (cancels a running handoff first)',
  category: 'global',
  match: (e) => e.key === 'Escape'
}

export const zoomIn: ShortcutEntry = {
  id: 'zoom-in',
  keyLabel: 'Ctrl+ / Ctrl+=',
  description: 'zoom in (whole app)',
  category: 'global',
  match: (e) => e.ctrlKey && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')
}

export const zoomOut: ShortcutEntry = {
  id: 'zoom-out',
  keyLabel: 'Ctrl−',
  description: 'zoom out (whole app)',
  category: 'global',
  match: (e) => e.ctrlKey && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')
}

export const zoomReset: ShortcutEntry = {
  id: 'zoom-reset',
  keyLabel: 'Ctrl+0',
  description: 'zoom reset (whole app)',
  category: 'global',
  match: (e) => e.ctrlKey && !e.altKey && e.code === 'Digit0'
}

export const fontZoomIn: ShortcutEntry = {
  id: 'font-zoom-in',
  keyLabel: 'Ctrl+Alt+',
  description: 'terminal font size up',
  category: 'global',
  match: (e) => e.ctrlKey && e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')
}

export const fontZoomOut: ShortcutEntry = {
  id: 'font-zoom-out',
  keyLabel: 'Ctrl+Alt−',
  description: 'terminal font size down',
  category: 'global',
  match: (e) => e.ctrlKey && e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')
}

export const fontZoomReset: ShortcutEntry = {
  id: 'font-zoom-reset',
  keyLabel: 'Ctrl+Alt+0',
  description: 'terminal font size reset',
  category: 'global',
  match: (e) => e.ctrlKey && e.altKey && e.code === 'Digit0'
}

export const toggleSidebar: ShortcutEntry = {
  id: 'toggle-sidebar',
  keyLabel: 'Ctrl+B',
  description: 'toggle the sidebar',
  category: 'global',
  match: (e) => e.ctrlKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')
}

export const togglePanel: ShortcutEntry = {
  id: 'toggle-panel',
  keyLabel: 'Ctrl+Shift+B',
  description: 'open the "Add pane" menu',
  category: 'global',
  match: (e) => e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')
}

export const closeWorkspaceShortcut: ShortcutEntry = {
  id: 'close-workspace',
  keyLabel: 'Ctrl+Shift+W',
  description: 'close the current workspace',
  category: 'global',
  match: (e) => e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')
}

export const renameWorkspaceShortcut: ShortcutEntry = {
  id: 'rename-workspace',
  keyLabel: 'F2',
  description: 'rename the current workspace',
  category: 'global',
  match: (e) => e.key === 'F2'
}

export const selectPane: ShortcutEntry = {
  id: 'select-pane',
  keyLabel: '1–9',
  description: 'select pane (visual order)',
  category: 'global',
  match: (e) => e.key >= '1' && e.key <= '9'
}

export const newTerminal: ShortcutEntry = {
  id: 'new-terminal',
  keyLabel: 't',
  description: 'new terminal in this workspace',
  category: 'global',
  match: (e) => e.key === 't'
}

export const openFileShortcut: ShortcutEntry = {
  id: 'open-file',
  keyLabel: 'o',
  description: 'open a file in the editor',
  category: 'global',
  match: (e) => e.key === 'o'
}

export const newBrowserPane: ShortcutEntry = {
  id: 'new-browser-pane',
  keyLabel: 'b',
  description: 'new browser pane in this workspace',
  category: 'global',
  match: (e) => e.key === 'b'
}

export const expandPane: ShortcutEntry = {
  id: 'expand-pane',
  keyLabel: 'z',
  description: 'expand / collapse pane',
  category: 'global',
  match: (e) => e.key === 'z'
}

export const splitRight: ShortcutEntry = {
  id: 'split-right',
  keyLabel: 'd',
  description: 'split the pane to the right',
  category: 'global',
  match: (e) => e.key === 'd'
}

export const splitUp: ShortcutEntry = {
  id: 'split-up',
  keyLabel: 'w',
  description: 'split the pane upward',
  category: 'global',
  match: (e) => e.key === 'w'
}

export const splitLeft: ShortcutEntry = {
  id: 'split-left',
  keyLabel: 'a',
  description: 'split the pane to the left',
  category: 'global',
  match: (e) => e.key === 'a'
}

export const splitDown: ShortcutEntry = {
  id: 'split-down',
  keyLabel: 's',
  description: 'split the pane downward',
  category: 'global',
  match: (e) => e.key === 's'
}

export const tidyGrid: ShortcutEntry = {
  id: 'tidy-grid',
  keyLabel: 'y',
  description: 'tidy panes into a balanced grid',
  category: 'global',
  match: (e) => e.key === 'y'
}

export const equalizePanes: ShortcutEntry = {
  id: 'equalize-panes',
  keyLabel: '=',
  description: 'reset every split to an even share',
  category: 'global',
  match: (e) => !e.ctrlKey && !e.altKey && !e.metaKey && e.key === '='
}

export const focusPrevPane: ShortcutEntry = {
  id: 'focus-prev-pane',
  keyLabel: '[',
  description: 'focus the previous pane',
  category: 'global',
  match: (e) => e.key === '['
}

export const focusNextPane: ShortcutEntry = {
  id: 'focus-next-pane',
  keyLabel: ']',
  description: 'focus the next pane',
  category: 'global',
  match: (e) => e.key === ']'
}

export const movePanePrev: ShortcutEntry = {
  id: 'move-pane-prev',
  keyLabel: '{',
  description: 'swap this pane with the previous one',
  category: 'global',
  match: (e) => e.key === '{'
}

export const movePaneNext: ShortcutEntry = {
  id: 'move-pane-next',
  keyLabel: '}',
  description: 'swap this pane with the next one',
  category: 'global',
  match: (e) => e.key === '}'
}

export const toggleGit: ShortcutEntry = {
  id: 'toggle-git',
  keyLabel: 'g',
  description: 'toggle the Source control panel',
  category: 'global',
  match: (e) => e.key === 'g'
}

export const shortcutSheetShortcut: ShortcutEntry = {
  id: 'shortcut-sheet',
  keyLabel: '?',
  description: 'show this shortcuts sheet',
  category: 'global',
  match: (e) => e.key === '?'
}

export const browserFocusUrl: ShortcutEntry = {
  id: 'browser-focus-url',
  keyLabel: 'Ctrl+L',
  description: 'focus the browser address bar',
  category: 'global',
  match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')
}

export const settingsShortcut: ShortcutEntry = {
  id: 'settings',
  keyLabel: 'Ctrl+,',
  description: 'open settings',
  category: 'global',
  match: (e) => e.ctrlKey && e.key === ','
}

export const commandPaletteShortcut: ShortcutEntry = {
  id: 'command-palette',
  keyLabel: 'Ctrl+K',
  description: 'open the command palette',
  category: 'global',
  match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')
}

export function focusedPaneOwnsKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return true
  return (
    toggleSidebar.match?.(e) === true ||
    commandPaletteShortcut.match?.(e) === true ||
    browserFocusUrl.match?.(e) === true
  )
}

export const GLOBAL_SHORTCUTS: ShortcutEntry[] = [
  escapeShortcut,
  zoomIn,
  zoomOut,
  zoomReset,
  fontZoomIn,
  fontZoomOut,
  fontZoomReset,
  toggleSidebar,
  togglePanel,
  closeWorkspaceShortcut,
  renameWorkspaceShortcut,
  selectPane,
  newTerminal,
  openFileShortcut,
  newBrowserPane,
  expandPane,
  splitRight,
  splitDown,
  splitLeft,
  splitUp,
  tidyGrid,
  equalizePanes,
  focusPrevPane,
  focusNextPane,
  movePanePrev,
  movePaneNext,
  toggleGit,
  shortcutSheetShortcut,
  browserFocusUrl,
  settingsShortcut,
  commandPaletteShortcut
]

export const dictationShortcut: ShortcutEntry = {
  id: 'voice-dictate',
  keyLabel: 'Ctrl+Shift+Space',
  description: 'hold to dictate into this terminal (Settings → Voice)',
  category: 'terminal',
  chord: { code: 'Space', ctrl: true, alt: false, shift: true, meta: false },
  remappable: true
}

export function isDictationChord(e: KeyboardEvent, overrides?: KeymapOverrides): boolean {
  const bound = overrides?.bindings[dictationShortcut.id]
  if (bound) return chordMatchesEvent(bound, e)
  if (e.altKey || e.metaKey) return false
  if (!e.ctrlKey || !e.shiftKey) return false
  return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32
}

export function endsDictationHold(e: KeyboardEvent, overrides?: KeymapOverrides): boolean {
  const bound = overrides?.bindings[dictationShortcut.id]
  if (bound) {
    if (e.code === bound.code) return true
    return (
      (bound.ctrl && e.key === 'Control') ||
      (bound.shift && e.key === 'Shift') ||
      (bound.alt && e.key === 'Alt') ||
      (bound.meta && e.key === 'Meta')
    )
  }
  return (
    e.code === 'Space' ||
    e.key === ' ' ||
    e.key === 'Spacebar' ||
    e.key === 'Control' ||
    e.key === 'Shift'
  )
}

const TERMINAL_SHORTCUTS: ShortcutEntry[] = [
  {
    id: 'term-copy',
    keyLabel: 'Ctrl+C',
    description: 'copy selection (no selection: interrupts the agent)',
    category: 'terminal',
    chord: { code: 'KeyC', ctrl: true, alt: false, shift: false, meta: false }
  },
  {
    id: 'term-copy-force',
    keyLabel: 'Ctrl+Shift+C',
    description: 'copy selection',
    category: 'terminal',
    chord: { code: 'KeyC', ctrl: true, alt: false, shift: true, meta: false }
  },
  {
    id: 'term-paste',
    keyLabel: 'Ctrl+V / Ctrl+Shift+V',
    description: 'paste (accepts screenshots)',
    category: 'terminal',
    chord: { code: 'KeyV', ctrl: true, alt: false, shift: false, meta: false }
  },
  {
    id: 'term-find',
    keyLabel: 'Ctrl+F',
    description: 'find in the terminal',
    category: 'terminal',
    chord: { code: 'KeyF', ctrl: true, alt: false, shift: false, meta: false }
  },
  dictationShortcut
]

export function isPasteChord(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey) return false
  if (e.ctrlKey && (e.code === 'KeyV' || e.key?.toLowerCase() === 'v' || e.keyCode === 86)) {
    return true
  }
  return e.shiftKey && (e.code === 'Insert' || e.key === 'Insert' || e.keyCode === 45)
}

export const splitEditorDown: ShortcutEntry = {
  id: 'split-editor-down',
  keyLabel: 'Ctrl+Shift+D',
  description: 'split the editor pane down',
  category: 'editor',
  chord: { code: 'KeyD', ctrl: true, alt: false, shift: true, meta: false }
}

const EDITOR_SHORTCUTS: ShortcutEntry[] = [splitEditorDown]

const GESTURE_SHORTCUTS: ShortcutEntry[] = [
  {
    id: 'gesture-click',
    keyLabel: 'click',
    description: 'select a terminal & type (every key reaches the agent)',
    category: 'gesture'
  },
  {
    id: 'gesture-click-away',
    keyLabel: 'click away',
    description: 'deselect the terminal',
    category: 'gesture'
  },
  {
    id: 'gesture-dblclick-title',
    keyLabel: 'double-click title',
    description: 'rename the session',
    category: 'gesture'
  },
  {
    id: 'gesture-drag-header',
    keyLabel: 'drag header',
    description: 'move a pane onto another pane’s edge',
    category: 'gesture'
  }
]

export const KEYMAP: ShortcutEntry[] = [
  ...GLOBAL_SHORTCUTS,
  ...TERMINAL_SHORTCUTS,
  ...EDITOR_SHORTCUTS,
  ...GESTURE_SHORTCUTS
]

function chordMatchesEvent(chord: Chord, e: KeyboardEvent): boolean {
  return (
    e.code === chord.code &&
    e.ctrlKey === chord.ctrl &&
    e.altKey === chord.alt &&
    e.shiftKey === chord.shift &&
    e.metaKey === chord.meta
  )
}

export function chordFromEvent(e: KeyboardEvent): Chord {
  return { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
}

export function isModifierKeydown(e: KeyboardEvent): boolean {
  return e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta'
}

const MODIFIER_ORDER: Array<[key: 'ctrl' | 'alt' | 'shift' | 'meta', label: string]> = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta']
]

const CODE_LABELS: Record<string, string> = {
  Equal: '=',
  NumpadAdd: 'Num+',
  Minus: '-',
  NumpadSubtract: 'Num-',
  Digit0: '0',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Meta',
  MetaRight: 'Meta'
}

function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

export function chordLabel(chord: Chord): string {
  const mods = MODIFIER_ORDER.filter(([k]) => chord[k]).map(([, label]) => label)
  return [...mods, codeLabel(chord.code)].join('+')
}

function matchesOverride(entry: ShortcutEntry, chord: Chord, e: KeyboardEvent): boolean {
  if (entry.id === 'select-pane') {
    return (
      e.key >= '1' &&
      e.key <= '9' &&
      e.ctrlKey === chord.ctrl &&
      e.altKey === chord.alt &&
      e.shiftKey === chord.shift &&
      e.metaKey === chord.meta
    )
  }
  return chordMatchesEvent(chord, e)
}

export function resolveMatch(
  entry: ShortcutEntry,
  overrides: KeymapOverrides
): (e: KeyboardEvent) => boolean {
  const chord = overrides.bindings[entry.id]
  if (!chord) return entry.match ?? (() => false)
  return (e) => matchesOverride(entry, chord, e)
}

export function resolveGlobalMatch(
  entry: ShortcutEntry,
  overrides: KeymapOverrides
): (e: KeyboardEvent) => boolean {
  if (!overrides.shortcuts_enabled) return () => false
  return resolveMatch(entry, overrides)
}

const SPLIT_SIDES: readonly (readonly [ShortcutEntry, SplitSide])[] = [
  [splitRight, 'right'],
  [splitDown, 'bottom'],
  [splitLeft, 'left'],
  [splitUp, 'top']
]

export function splitSideFor(e: KeyboardEvent, overrides: KeymapOverrides): SplitSide | null {
  for (const [entry, side] of SPLIT_SIDES) {
    if (resolveGlobalMatch(entry, overrides)(e)) return side
  }
  return null
}

export function effectiveLabel(entry: ShortcutEntry, overrides: KeymapOverrides): string {
  const chord = overrides.bindings[entry.id]
  if (!chord) return entry.keyLabel
  if (entry.id === 'select-pane') {
    const mods = MODIFIER_ORDER.filter(([k]) => chord[k]).map(([, label]) => label)
    return [...mods, '1–9'].join('+')
  }
  return chordLabel(chord)
}

export type KeymapConflict =
  | { kind: 'shortcut'; entry: ShortcutEntry }
  | { kind: 'terminal'; entry: ShortcutEntry }
  | { kind: 'editor'; entry: ShortcutEntry }

function effectiveChord(entry: ShortcutEntry, overrides: KeymapOverrides): Chord | undefined {
  return overrides.bindings[entry.id] ?? entry.chord
}

export function findConflict(
  entryId: string,
  e: KeyboardEvent,
  overrides: KeymapOverrides
): KeymapConflict | null {
  for (const other of GLOBAL_SHORTCUTS) {
    if (other.id === entryId) continue
    if (resolveMatch(other, overrides)(e)) return { kind: 'shortcut', entry: other }
  }
  for (const term of TERMINAL_SHORTCUTS) {
    if (term.id === entryId) continue
    const chord = effectiveChord(term, overrides)
    if (chord && chordMatchesEvent(chord, e)) return { kind: 'terminal', entry: term }
  }
  for (const ed of EDITOR_SHORTCUTS) {
    if (ed.id === entryId) continue
    const chord = effectiveChord(ed, overrides)
    if (chord && chordMatchesEvent(chord, e)) return { kind: 'editor', entry: ed }
  }
  return null
}
