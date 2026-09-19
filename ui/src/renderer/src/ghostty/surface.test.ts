import { describe, expect, it, vi } from 'vitest'

import type { GhosttyCell, GhosttyRow } from './core'
import { DEFAULT_TERMINAL_LINE_HEIGHT } from './renderer'
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT,
  SCROLLBACK_BYTES_PER_CELL_ESTIMATE,
  advanceTerminalSelectionClickSequence,
  decideKeyRelease,
  ghosttyMouseButton,
  isMacPlatform,
  isTerminalAltGraphText,
  isTerminalCompositionCommitInput,
  isTerminalCopyShortcut,
  isTerminalLinkPointerGesture,
  isTerminalPasteShortcut,
  loadTerminalFontFamily,
  quoteCanvasFontFamilies,
  scrollbackLinesToBytes,
  shouldBlinkTerminalCursor,
  shouldReportTerminalMouse,
  shouldShowTerminalLinkHover,
  terminalContentOriginY,
  terminalFontFamily,
  terminalFontSize,
  terminalGridCellAt,
  terminalLineHeight,
  terminalLinkAtPosition,
  terminalLinkAtPositionWithRange,
  terminalPointerDownIntent,
  terminalWheelAction,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalWheelArrowData,
  terminalWheelDeltaRows
} from './surface'

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false
})

const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
  cells: Array.from(text.padEnd(16), (character) => cell(character)),
  text: text.trimEnd(),
  isWrapContinuation,
  wrapsToNext
})

describe('isTerminalAltGraphText', () => {
  it('defers printable AltGr output to the textarea input event', () => {
    expect(
      isTerminalAltGraphText({
        key: '@',
        getModifierState: (modifier) => modifier === 'AltGraph'
      })
    ).toBe(true)
    expect(
      isTerminalAltGraphText({
        key: 'ArrowRight',
        getModifierState: (modifier) => modifier === 'AltGraph'
      })
    ).toBe(false)
  })
})

describe('decideKeyRelease', () => {
  const encodeRelease = vi.fn(() => '[32;2;32u')

  it('a consumed press still lets its release reach the pane, unencoded', () => {
    const encode = vi.fn(() => '[32;2;32u')
    const verdict = decideKeyRelease({
      claimedByPane: false,
      pressWasSuppressed: true,
      isComposingTail: false,
      encodeRelease: encode
    })
    expect(verdict).toEqual({ action: 'swallow' })
    expect(encode).not.toHaveBeenCalled()
  })

  it('a release the pane claims is consumed and never encoded', () => {
    const encode = vi.fn(() => '[32;2;32u')
    expect(
      decideKeyRelease({
        claimedByPane: true,
        pressWasSuppressed: false,
        isComposingTail: false,
        encodeRelease: encode
      })
    ).toEqual({ action: 'consumed-by-pane' })
    expect(encode).not.toHaveBeenCalled()
  })

  it('an unsuppressed release encodes and sends, exactly as before the fix', () => {
    expect(
      decideKeyRelease({
        claimedByPane: false,
        pressWasSuppressed: false,
        isComposingTail: false,
        encodeRelease
      })
    ).toEqual({ action: 'send', data: '[32;2;32u' })
  })

  it('composition tails and empty encodes stay unencoded', () => {
    expect(
      decideKeyRelease({
        claimedByPane: false,
        pressWasSuppressed: false,
        isComposingTail: true,
        encodeRelease
      })
    ).toEqual({ action: 'ignored' })
    expect(
      decideKeyRelease({
        claimedByPane: false,
        pressWasSuppressed: false,
        isComposingTail: false,
        encodeRelease: () => ''
      })
    ).toEqual({ action: 'ignored' })
  })
})

describe('terminalGridCellAt', () => {
  const options = {
    bounds: { left: 100, top: 200 },
    cols: 3,
    rows: 2,
    metrics: { width: 10, height: 20 },
    padding: 4,
    originY: 24
  }

  it('maps points inside the rendered grid without clamping its padding', () => {
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 224 })).toEqual({ x: 0, y: 0 })
    expect(terminalGridCellAt({ ...options, clientX: 133, clientY: 263 })).toEqual({ x: 2, y: 1 })
    expect(terminalGridCellAt({ ...options, clientX: 103, clientY: 224 })).toBeNull()
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 223 })).toBeNull()
    expect(terminalGridCellAt({ ...options, clientX: 134, clientY: 224 })).toBeNull()
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 264 })).toBeNull()
  })
})

describe('shouldBlinkTerminalCursor', () => {
  const blinking = {
    focused: true,
    cursorBlinking: true,
    cursorVisible: true,
    reducedMotion: false
  }

  it('blinks a focused visible cursor the terminal asked to blink', () => {
    expect(shouldBlinkTerminalCursor(blinking)).toBe(true)
  })

  it('holds the cursor steady when blinking would be unwanted', () => {
    expect(shouldBlinkTerminalCursor({ ...blinking, focused: false })).toBe(false)
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorBlinking: false })).toBe(false)
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorVisible: false })).toBe(false)
    expect(shouldBlinkTerminalCursor({ ...blinking, reducedMotion: true })).toBe(false)
  })
})

describe('terminalLinkAtPosition', () => {
  it('maps terminal cells to UTF-16 offsets after a wide emoji', () => {
    const cells = [cell('🙂'), cell(''), ...Array.from('https://t3.codes', (c) => cell(c))]
    const wide: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || ' ')
        .join('')
        .trimEnd(),
      isWrapContinuation: false,
      wrapsToNext: false
    }

    expect(terminalLinkAtPosition([wide], 0, 2)).toBe('https://t3.codes')
    expect(terminalLinkAtPosition([wide], 0, cells.length - 1)).toBe('https://t3.codes')
    expect(terminalLinkAtPosition([wide], 0, 0)).toBeNull()
    expect(terminalLinkAtPositionWithRange([wide], 0, 8)?.range).toEqual({
      start: { x: 2, y: 0 },
      end: { x: cells.length - 1, y: 0 }
    })
  })

  it('reconstructs a soft-wrapped URL through Houston’s own wrap stitching', () => {
    const rows = [row('https://example.', false), row('com/reference', true)]

    expect(terminalLinkAtPosition(rows, 0, 8)).toBe('https://example.com/reference')
    expect(terminalLinkAtPosition(rows, 1, 4)).toBe('https://example.com/reference')
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)).toEqual({
      text: 'https://example.com/reference',
      range: { start: { x: 0, y: 0 }, end: { x: 12, y: 1 } }
    })
  })

  it('leaves file paths to the pane’s resolveLink seam', () => {
    const rows = [row('~/project/file', false), row('/etc/hosts', false)]
    expect(terminalLinkAtPosition(rows, 0, 2)).toBeNull()
    expect(terminalLinkAtPosition(rows, 1, 2)).toBeNull()
  })

  it('refuses links truncated at the viewport edges instead of mis-resolving', () => {
    const headCut = [row('ple.com/missing', true), row('head', true)]
    expect(terminalLinkAtPosition(headCut, 0, 4)).toBeNull()
    const tailCut = [row('https://t3.codes', false, true)]
    expect(terminalLinkAtPosition(tailCut, 0, 8)).toBeNull()
    const complete = [row('https://t3.codes', false), row('', false)]
    expect(terminalLinkAtPosition(complete, 0, 8)).toBe('https://t3.codes')
    const wideFull: GhosttyRow = {
      cells: [
        { ...cell('🙂'), wide: 1 },
        { ...cell(''), wide: 2 },
        ...Array.from('https://t3.code', (character) => cell(character))
      ],
      text: '🙂 https://t3.code',
      isWrapContinuation: false,
      wrapsToNext: true
    }
    expect(terminalLinkAtPosition([wideFull], 0, 8)).toBeNull()
    const unwrittenTail: GhosttyRow = {
      cells: [...Array.from('https://t3.codes', (character) => cell(character)), cell(''), cell('')],
      text: 'https://t3.codes',
      isWrapContinuation: false,
      wrapsToNext: false
    }
    expect(terminalLinkAtPosition([unwrittenTail], 0, 8)).toBe('https://t3.codes')
  })
})

describe('isTerminalCopyShortcut', () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalCopyShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: 'c',
    metaKey: false,
    shiftKey: false,
    ...overrides
  })

  it('keeps Ctrl+C available for SIGINT on macOS', () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), 'MacIntel')).toBe(false)
    expect(isTerminalCopyShortcut(event({ metaKey: true }), 'MacIntel')).toBe(true)
  })

  it('copies with Ctrl+C and Ctrl+Shift+C elsewhere', () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), 'Linux x86_64')).toBe(true)
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, shiftKey: true }), 'Linux x86_64')).toBe(
      true
    )
    expect(isTerminalCopyShortcut(event({ metaKey: true }), 'Linux x86_64')).toBe(false)
  })

  it('uses the produced character instead of the physical key position', () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, key: 'C' }), 'Linux x86_64')).toBe(true)
    expect(isTerminalCopyShortcut(event({ ctrlKey: true, key: 'v' }), 'Linux x86_64')).toBe(false)
  })
})

describe('isTerminalPasteShortcut', () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalPasteShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: 'v',
    metaKey: false,
    shiftKey: false,
    ...overrides
  })

  it('uses Cmd+V on macOS', () => {
    expect(isTerminalPasteShortcut(event({ metaKey: true }), 'MacIntel')).toBe(true)
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), 'MacIntel')).toBe(false)
  })

  it('preserves Ctrl+V for the shell and uses Ctrl+Shift+V elsewhere', () => {
    expect(isTerminalPasteShortcut(event({ ctrlKey: true }), 'Linux x86_64')).toBe(false)
    expect(isTerminalPasteShortcut(event({ ctrlKey: true, shiftKey: true }), 'Linux x86_64')).toBe(
      true
    )
  })

  it('supports the conventional Shift+Insert paste shortcut', () => {
    expect(isTerminalPasteShortcut(event({ key: 'Insert', shiftKey: true }), 'Linux x86_64')).toBe(
      true
    )
    expect(isTerminalPasteShortcut(event({ key: 'Insert' }), 'Linux x86_64')).toBe(false)
    expect(isTerminalPasteShortcut(event({ key: 'Insert', shiftKey: true }), 'MacIntel')).toBe(false)
  })
})

describe('isTerminalCompositionCommitInput', () => {
  it('identifies browser composition follow-up input', () => {
    expect(isTerminalCompositionCommitInput({ inputType: '' })).toBe(true)
    expect(isTerminalCompositionCommitInput({ inputType: 'insertCompositionText' })).toBe(true)
    expect(isTerminalCompositionCommitInput({ inputType: 'insertFromComposition' })).toBe(true)
  })

  it('keeps a fast repeated input as legitimate text', () => {
    expect(isTerminalCompositionCommitInput({ inputType: 'insertText' })).toBe(false)
  })
})

describe('application mouse reporting', () => {
  const event = { ctrlKey: false, metaKey: false, shiftKey: false }

  it('keeps Shift and link activation modifiers available to the browser', () => {
    expect(shouldReportTerminalMouse(true, event)).toBe(true)
    expect(shouldReportTerminalMouse(false, event)).toBe(false)
    expect(shouldReportTerminalMouse(true, { ...event, shiftKey: true })).toBe(false)
    expect(shouldReportTerminalMouse(true, { ...event, ctrlKey: true })).toBe(false)
    expect(shouldReportTerminalMouse(true, { ...event, metaKey: true })).toBe(false)
  })

  it("maps browser buttons to Ghostty's button enum", () => {
    expect([0, 1, 2, 3, 4, 5].map(ghosttyMouseButton)).toEqual([1, 3, 2, 4, 5, null])
  })

  it('only shows link hover during mouse tracking when the link modifier is held', () => {
    expect(shouldShowTerminalLinkHover(false, false)).toBe(true)
    expect(shouldShowTerminalLinkHover(true, false)).toBe(false)
    expect(shouldShowTerminalLinkHover(true, true)).toBe(true)
  })
})

describe('terminal font resolution', () => {
  it('validates the requested face after its styles load', async () => {
    const load = vi.fn(async (_font: string, _text: string): Promise<unknown> => [])
    const resolve = vi.fn(() => '"Fira Code", monospace')
    const resolved = await loadTerminalFontFamily('Fira Code', 14, { load, resolve })

    expect(resolved).toBe('"Fira Code", monospace')
    expect(load).toHaveBeenCalledTimes(4)
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      'normal 400 14px "Fira Code"',
      'normal 700 14px "Fira Code"',
      'italic 400 14px "Fira Code"',
      'italic 700 14px "Fira Code"'
    ])
    expect(resolve).toHaveBeenCalledWith('Fira Code')
  })

  it('resolves a requested stack as given and falls back when none is requested', () => {
    expect(terminalFontFamily('"JetBrains Mono", monospace')).toBe('"JetBrains Mono", monospace')
    expect(terminalFontFamily(undefined)).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(terminalFontFamily('')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
  })

  it('quotes families the canvas font shorthand would otherwise reject', () => {
    expect(quoteCanvasFontFamilies('ui-monospace, "SF Mono", Menlo, monospace')).toBe(
      '"ui-monospace", "SF Mono", "Menlo", monospace'
    )
    expect(quoteCanvasFontFamilies('monospace, serif, system-ui')).toBe(
      'monospace, serif, system-ui'
    )
    expect(quoteCanvasFontFamilies('3270 Nerd Font, M+ 1m')).toBe('"3270 Nerd Font", "M+ 1m"')
    expect(quoteCanvasFontFamilies('Weird"Name')).toBe('"WeirdName"')
    expect(quoteCanvasFontFamilies('  ,  , monospace')).toBe('monospace')
  })

  it('clamps requested font sizes to the supported range', () => {
    expect(terminalFontSize(undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE)
    expect(terminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE)
    expect(terminalFontSize(2)).toBe(6)
    expect(terminalFontSize(99)).toBe(32)
    expect(terminalFontSize(13.4)).toBe(13)
  })

  it('clamps requested line-height multipliers to the supported range', () => {
    expect(terminalLineHeight(undefined)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT)
    expect(terminalLineHeight(Number.NaN)).toBe(DEFAULT_TERMINAL_LINE_HEIGHT)
    expect(terminalLineHeight(0.1)).toBe(MIN_TERMINAL_LINE_HEIGHT)
    expect(terminalLineHeight(9)).toBe(MAX_TERMINAL_LINE_HEIGHT)
    expect(terminalLineHeight(1.4)).toBe(1.4)
  })
})

describe('scrollbackLinesToBytes', () => {
  it('scales by cols and the documented per-cell byte estimate', () => {
    expect(scrollbackLinesToBytes(10_000, 80)).toBe(10_000 * 80 * SCROLLBACK_BYTES_PER_CELL_ESTIMATE)
    expect(scrollbackLinesToBytes(0, 80)).toBe(0)
  })
})

describe('isMacPlatform', () => {
  it('recognizes the apple platform strings and nothing else', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('iPhone')).toBe(true)
    expect(isMacPlatform('Linux x86_64')).toBe(false)
    expect(isMacPlatform('Win32')).toBe(false)
  })
})

describe('terminalContentOriginY', () => {
  it('stays top-anchored like a fresh terminal until scrollback exists', () => {
    expect(terminalContentOriginY(200, 4, 9, 20, false)).toBe(4)
  })

  it('pins the grid to the bottom by moving the sub-row slack above row 0', () => {
    expect(terminalContentOriginY(200, 4, 9, 20, true)).toBe(16)
  })

  it('keeps the prompt stationary while a drag crosses row boundaries', () => {
    expect(terminalContentOriginY(210, 4, 9, 20, true)).toBe(26)
    expect(terminalContentOriginY(228, 4, 10, 20, true)).toBe(24)
  })

  it('snaps the bottom-anchored origin onto the device pixel grid', () => {
    expect(terminalContentOriginY(210.4, 4, 9, 20, true, 1.25)).toBe(26.4)
    expect(terminalContentOriginY(210.37, 4, 9, 20, true, 1.25)).toBe(26.4)
    expect(terminalContentOriginY(210.37, 4, 9, 20, true)).toBe(26)
  })

  it('leaves the top-anchored origin alone, which is already whole', () => {
    expect(terminalContentOriginY(210.37, 4, 9, 20, false, 1.25)).toBe(4)
  })
})

describe('terminalWheelDeltaRows', () => {
  it('converts line-mode deltas into whole rows', () => {
    expect(terminalWheelDeltaRows({ deltaY: 3, deltaMode: 1 }, 20, 24, 0)).toEqual({
      rows: 3,
      remainder: 0
    })
  })

  it('accumulates fractional pixel deltas across events', () => {
    const first = terminalWheelDeltaRows({ deltaY: 12, deltaMode: 0 }, 20, 24, 0)
    expect(first.rows).toBe(0)
    expect(first.remainder).toBeCloseTo(0.6)
    const second = terminalWheelDeltaRows({ deltaY: 12, deltaMode: 0 }, 20, 24, first.remainder)
    expect(second.rows).toBe(1)
    expect(second.remainder).toBeCloseTo(0.2)
  })

  it('keeps direction for negative page-mode deltas', () => {
    expect(terminalWheelDeltaRows({ deltaY: -1, deltaMode: 2 }, 20, 24, 0)).toEqual({
      rows: -24,
      remainder: 0
    })
  })
})

describe('terminalWheelArrowData', () => {
  it('emits one arrow per row honoring application cursor keys', () => {
    expect(terminalWheelArrowData(0, false)).toBe('')
    expect(terminalWheelArrowData(2, false)).toBe('\u001b[B\u001b[B')
    expect(terminalWheelArrowData(-2, false)).toBe('\u001b[A\u001b[A')
    expect(terminalWheelArrowData(1, true)).toBe('\u001bOB')
    expect(terminalWheelArrowData(-1, true)).toBe('\u001bOA')
  })
})

describe('isTerminalLinkPointerGesture', () => {
  it('uses Command on macOS and Control elsewhere', () => {
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, 'MacIntel')).toBe(true)
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, 'MacIntel')).toBe(false)
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, 'Linux x86_64')).toBe(
      true
    )
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: true }, 'Linux x86_64')).toBe(
      false
    )
  })
})

describe('terminalWheelAction', () => {
  const wheel = (mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; deltaY?: number }) => ({
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    deltaY: mods.deltaY ?? 120
  })
  const normal = { mouseTracking: false, alternateScreen: false, focused: true }
  const altScreen = { mouseTracking: false, alternateScreen: true, focused: true }
  const trackingTui = { mouseTracking: true, alternateScreen: true, focused: true }

  it('never steals a modifier wheel — Ctrl+wheel is zoom, Meta is an app binding', () => {
    expect(terminalWheelAction(wheel({ ctrl: true }), altScreen)).toBe('native')
    expect(terminalWheelAction(wheel({ meta: true }), normal)).toBe('native')
  })

  it('scrolls the viewport in the normal buffer — scrollback is the correct response', () => {
    expect(terminalWheelAction(wheel({}), normal)).toBe('scroll')
  })

  it('reports to an app that asked for the mouse itself', () => {
    expect(terminalWheelAction(wheel({}), trackingTui)).toBe('report')
  })

  it('translates to arrows on the alternate screen, where nothing else consumes it', () => {
    expect(terminalWheelAction(wheel({}), altScreen)).toBe('arrows')
  })

  it('injects no arrows into an unfocused surface — a hover must not type', () => {
    expect(terminalWheelAction(wheel({}), { ...altScreen, focused: false })).toBe('native')
  })

  it('lets Shift bypass a tracking app, like force-select does (deliberate divergence)', () => {
    expect(terminalWheelAction(wheel({ shift: true }), trackingTui)).toBe('arrows')
  })

  it('does nothing for a zero-delta event', () => {
    expect(terminalWheelAction(wheel({ deltaY: 0 }), altScreen)).toBe('native')
  })
})

describe('terminalPointerDownIntent', () => {
  const press = (mods: { ctrl?: boolean; shift?: boolean; meta?: boolean }, button = 0) => ({
    button,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false
  })
  const plainPane = { mouseTracking: false, alternateScreen: false }
  const tuiPane = { mouseTracking: true, alternateScreen: true }
  const linux = 'Linux x86_64'

  it('routes a plain drag to selection on a non-tracking pane (the CC pane case)', () => {
    expect(terminalPointerDownIntent(press({}), plainPane, linux)).toBe('select')
  })

  it('forwards a plain press to a tracking app, and Shift overrides back to selection', () => {
    expect(terminalPointerDownIntent(press({}), tuiPane, linux)).toBe('report')
    expect(terminalPointerDownIntent(press({ shift: true }), tuiPane, linux)).toBe('select')
  })

  it("reserves Ctrl+Shift over a tracking alt-screen TUI for Q9's drag copy", () => {
    expect(terminalPointerDownIntent(press({ ctrl: true, shift: true }), tuiPane, linux)).toBe(
      'tui-drag-copy'
    )
  })

  it('never claims Ctrl+Shift for link activation (the pre-fix behavior)', () => {
    expect(terminalPointerDownIntent(press({ ctrl: true, shift: true }), plainPane, linux)).toBe(
      'select'
    )
    expect(
      terminalPointerDownIntent(press({ meta: true, shift: true }), plainPane, 'MacIntel')
    ).toBe('select')
  })

  it('keeps Ctrl+click (Cmd on mac) as link activation', () => {
    expect(terminalPointerDownIntent(press({ ctrl: true }), plainPane, linux)).toBe('link')
    expect(terminalPointerDownIntent(press({ meta: true }), plainPane, 'MacIntel')).toBe('link')
  })

  it('ignores non-primary buttons when there is no app to report to', () => {
    expect(terminalPointerDownIntent(press({}, 1), plainPane, linux)).toBe('ignore')
  })
})

describe('advanceTerminalSelectionClickSequence', () => {
  it('recognizes stationary double and triple presses without PointerEvent.detail', () => {
    const first = advanceTerminalSelectionClickSequence(null, {
      clientX: 10,
      clientY: 10,
      timeStamp: 1000
    })
    expect(first.count).toBe(1)
    const second = advanceTerminalSelectionClickSequence(first, {
      clientX: 11,
      clientY: 11,
      timeStamp: 1200
    })
    expect(second.count).toBe(2)
    const third = advanceTerminalSelectionClickSequence(second, {
      clientX: 11,
      clientY: 12,
      timeStamp: 1400
    })
    expect(third.count).toBe(3)
  })

  it('starts over after movement, delay, or a completed triple click', () => {
    const base = { count: 2, time: 1000, x: 10, y: 10 }
    expect(
      advanceTerminalSelectionClickSequence(base, { clientX: 40, clientY: 10, timeStamp: 1100 })
        .count
    ).toBe(1)
    expect(
      advanceTerminalSelectionClickSequence(base, { clientX: 10, clientY: 10, timeStamp: 1600 })
        .count
    ).toBe(1)
    expect(
      advanceTerminalSelectionClickSequence(
        { ...base, count: 3 },
        { clientX: 10, clientY: 10, timeStamp: 1100 }
      ).count
    ).toBe(1)
  })
})

describe('terminal scrollbar', () => {
  it("maps Ghostty's viewport state to a proportional thumb", () => {
    expect(terminalScrollbarGeometry({ total: 100, offset: 0, len: 25 }, 200)).toEqual({
      thumbHeight: 50,
      thumbTop: 0,
      maxOffset: 75
    })
    const middle = terminalScrollbarGeometry({ total: 100, offset: 75, len: 25 }, 200)
    expect(middle?.thumbTop).toBe(150)
    expect(terminalScrollbarGeometry({ total: 25, offset: 0, len: 25 }, 200)).toBeNull()
    expect(terminalScrollbarGeometry({ total: 100, offset: 0, len: 25 }, 0)).toBeNull()
  })

  it('keeps the thumb usable for large scrollback and maps dragging back to rows', () => {
    const geometry = terminalScrollbarGeometry({ total: 100_000, offset: 0, len: 25 }, 200)
    expect(geometry?.thumbHeight).toBe(18)
    expect(
      terminalScrollbarOffsetAtPointer({ total: 100, offset: 0, len: 25 }, 200, 150, 0)
    ).toBe(75)
    expect(
      terminalScrollbarOffsetAtPointer({ total: 100, offset: 0, len: 25 }, 200, 175, 25)
    ).toBe(75)
    expect(terminalScrollbarOffsetAtPointer({ total: 25, offset: 0, len: 25 }, 200, 100, 0)).toBe(0)
  })
})
