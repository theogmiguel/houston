import {
  GhosttyTerminalCore,
  type GhosttyColor,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme
} from './core'
import {
  boxFitsOneCell,
  DEFAULT_TERMINAL_LINE_HEIGHT,
  measureGhosttyCell,
  renderGhosttySnapshot,
  snapToDevice,
  syncCanvasBackground,
  terminalGridSize,
  type GhosttyCellMetrics,
  type GhosttyCellRange
} from './renderer'
import { findUrls, joinWrappedLine, mapJoinedOffset, type JoinedLine } from '../pane/webLinks'

export const DEFAULT_TERMINAL_FONT_SIZE = 13
const MIN_TERMINAL_FONT_SIZE = 6
const MAX_TERMINAL_FONT_SIZE = 32
export const MIN_TERMINAL_LINE_HEIGHT = 1
export const MAX_TERMINAL_LINE_HEIGHT = 2
export const SCROLLBACK_BYTES_PER_CELL_ESTIMATE = 16
const CONTENT_PADDING = 4
const MIN_SCROLLBAR_THUMB_HEIGHT = 18
const CURSOR_BLINK_INTERVAL_MS = 500
const RESIZE_NOTIFY_DEBOUNCE_MS = 150
const SELECTION_AUTOSCROLL_INTERVAL_MS = 80
const COMPOSITION_SUPPRESSION_MS = 100
const TERMINAL_FONT_LOAD_TEXT = 'iMW0@# .'
const TERMINAL_FONT_LOAD_VARIANTS = [
  'normal 400',
  'normal 700',
  'italic 400',
  'italic 700'
] as const
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "MesloLGS Nerd Font", ' +
  '"Symbols Nerd Font Mono", "SF Mono", Menlo, Monaco, monospace'

export interface GhosttyPaintStats {
  parseMs: number
  parseCalls: number
  parseBytes: number
  paintMs: number
  paintFrames: number
  coalescedRenders: number
}

const paintStats: GhosttyPaintStats = {
  parseMs: 0,
  parseCalls: 0,
  parseBytes: 0,
  paintMs: 0,
  paintFrames: 0,
  coalescedRenders: 0
}

;(globalThis as unknown as { __trGhosttyPaintStats__: GhosttyPaintStats }).__trGhosttyPaintStats__ =
  paintStats

export function ghosttyPaintStats(): GhosttyPaintStats {
  return paintStats
}

export interface GhosttyTerminalFont {
  readonly family?: string
  readonly size?: number
  readonly lineHeight?: number
}

export function isMacPlatform(platform = navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

const CANVAS_SAFE_GENERICS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui'
])

export function quoteCanvasFontFamilies(list: string): string {
  return list
    .split(',')
    .map((name) => {
      const bare = name.trim()
      if (bare.length === 0) return ''
      if (/^(['"]).*\1$/.test(bare)) return bare
      if (CANVAS_SAFE_GENERICS.has(bare.toLowerCase())) return bare
      return `"${bare.replaceAll('"', '')}"`
    })
    .filter((name) => name.length > 0)
    .join(', ')
}

export function terminalFontFamily(family?: string): string {
  const custom = family === undefined ? '' : quoteCanvasFontFamilies(family)
  return custom.length === 0 ? DEFAULT_TERMINAL_FONT_FAMILY : custom
}

export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<unknown>
    readonly resolve: (family: string | undefined) => string
  }
): Promise<string> {
  const candidate = terminalFontFamily(family)
  const load =
    environment?.load ?? ((font: string, text: string) => document.fonts.load(font, text))
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT)
      )
    )
  } catch {
  }
  return (environment?.resolve ?? terminalFontFamily)(family)
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)))
}

export function terminalLineHeight(lineHeight?: number): number {
  if (lineHeight === undefined || !Number.isFinite(lineHeight)) return DEFAULT_TERMINAL_LINE_HEIGHT
  return Math.max(MIN_TERMINAL_LINE_HEIGHT, Math.min(MAX_TERMINAL_LINE_HEIGHT, lineHeight))
}

export function scrollbackLinesToBytes(lines: number, cols: number): number {
  return Math.round(lines * cols * SCROLLBACK_BYTES_PER_CELL_ESTIMATE)
}

export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean
  readonly cursorBlinking: boolean
  readonly cursorVisible: boolean
  readonly reducedMotion: boolean
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion
}

export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
  devicePixelRatio = 1
): number {
  if (!anchorBottom) return padding
  const slack = mountHeight - padding * 2 - rows * cellHeight
  return snapToDevice(padding + Math.max(0, slack), devicePixelRatio)
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number
  readonly thumbTop: number
  readonly maxOffset: number
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total)
  const len = Math.max(0, Math.min(state.len, total))
  const maxOffset = Math.max(0, total - len)
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total)
  )
  const travel = Math.max(0, trackHeight - thumbHeight)
  const offset = Math.max(0, Math.min(state.offset, maxOffset))
  return { thumbHeight, thumbTop: travel * (offset / maxOffset), maxOffset }
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight)
  if (geometry === null) return 0
  const travel = Math.max(0, trackHeight - geometry.thumbHeight)
  if (travel === 0) return 0
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel))
  return Math.round((thumbTop / travel) * geometry.maxOffset)
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number }
  clientX: number
  clientY: number
  cols: number
  rows: number
  metrics: Pick<GhosttyCellMetrics, 'width' | 'height'>
  padding: number
  originY: number
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options
  const gridX = clientX - bounds.left - padding
  const gridY = clientY - bounds.top - originY
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null
  }
  return { x: Math.floor(gridX / metrics.width), y: Math.floor(gridY / metrics.height) }
}

function terminalRowText(row: GhosttySnapshot['rowData'][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || ' ').join('')
  return trimRight ? text.trimEnd() : text
}

function terminalColumnOffset(row: GhosttySnapshot['rowData'][number], column: number): number {
  let offset = 0
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1
  }
  return offset
}

function terminalColumnAtOffset(row: GhosttySnapshot['rowData'][number], offset: number): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    if (offset < terminalColumnOffset(row, column + 1)) return column
  }
  return Math.max(0, row.cells.length - 1)
}

export interface TerminalLinkWithRange {
  readonly text: string
  readonly range: GhosttyCellRange
}

function joinedSnapshotLine(rows: GhosttySnapshot['rowData'], rowIndex: number): JoinedLine {
  return joinWrappedLine(
    {
      getLine: (y) => {
        const row = rows[y]
        if (!row) return undefined
        return {
          isWrapped: row.isWrapContinuation,
          translateToString: (trimRight = false) => terminalRowText(row, trimRight)
        }
      }
    },
    rowIndex
  )
}

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot['rowData'],
  rowIndex: number,
  column: number
): TerminalLinkWithRange | null {
  const row = rows[rowIndex]
  if (!row) return null
  const joined = joinedSnapshotLine(rows, rowIndex)
  if (joined.rows.length === 0) return null
  const headRow = joined.rows[0]
  if (headRow !== undefined && rows[headRow]?.isWrapContinuation) return null
  const tailRow = joined.rows[joined.rows.length - 1]
  const continuesBelowViewport = tailRow !== undefined && (rows[tailRow]?.wrapsToNext ?? false)
  const segmentIndex = joined.rows.indexOf(rowIndex)
  if (segmentIndex === -1) return null
  const offset = joined.rowStarts[segmentIndex] + terminalColumnOffset(row, column)
  for (const match of findUrls(joined.text)) {
    if (offset < match.start || offset >= match.end) continue
    if (match.end === joined.text.length && continuesBelowViewport) return null
    const start = mapJoinedOffset(joined, match.start)
    const end = mapJoinedOffset(joined, match.end - 1)
    const startRow = rows[start.row]
    const endRow = rows[end.row]
    if (!startRow || !endRow) return null
    return {
      text: match.url,
      range: {
        start: { x: terminalColumnAtOffset(startRow, start.col), y: start.row },
        end: { x: terminalColumnAtOffset(endRow, end.col), y: end.row }
      }
    }
  }
  return null
}

export function terminalLinkAtPosition(
  rows: GhosttySnapshot['rowData'],
  rowIndex: number,
  column: number
): string | null {
  return terminalLinkAtPositionWithRange(rows, rowIndex, column)?.text ?? null
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform
): boolean {
  if (event.key.toLowerCase() !== 'c') return false
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform
): boolean {
  const key = event.key.toLowerCase()
  if (key === 'insert' && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey
  }
  if (key !== 'v') return false
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, 'inputType'>): boolean {
  return (
    event.inputType === '' ||
    event.inputType === 'insertCompositionText' ||
    event.inputType === 'insertFromComposition'
  )
}

export function decideCompositionInput(
  suppressed: string | null,
  data: string,
  event: Pick<InputEvent, 'inputType'>
): { readonly deliver: boolean; readonly clearSuppression: true } {
  const isEcho = suppressed !== null && data === suppressed && isTerminalCompositionCommitInput(event)
  return { deliver: !isEcho && data.length > 0, clearSuppression: true }
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, 'getModifierState' | 'key'>
): boolean {
  return event.getModifierState('AltGraph') && [...event.key].length === 1
}

export type KeyReleaseVerdict =
  | { readonly action: 'consumed-by-pane' }
  | { readonly action: 'swallow' }
  | { readonly action: 'ignored' }
  | { readonly action: 'send'; readonly data: string }

export function decideKeyRelease(input: {
  claimedByPane: boolean
  pressWasSuppressed: boolean
  isComposingTail: boolean
  encodeRelease: () => string
}): KeyReleaseVerdict {
  if (input.claimedByPane) return { action: 'consumed-by-pane' }
  if (input.pressWasSuppressed) return { action: 'swallow' }
  if (input.isComposingTail) return { action: 'ignored' }
  const data = input.encodeRelease()
  return data.length === 0 ? { action: 'ignored' } : { action: 'send', data }
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey
}

export function terminalPointerDownIntent(
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  state: { mouseTracking: boolean; alternateScreen: boolean },
  platform = navigator.platform
): 'report' | 'ignore' | 'tui-drag-copy' | 'link' | 'select' {
  if (shouldReportTerminalMouse(state.mouseTracking, event)) return 'report'
  if (event.button !== 0) return 'ignore'
  if (event.ctrlKey && event.shiftKey && state.mouseTracking && state.alternateScreen) {
    return 'tui-drag-copy'
  }
  if (isTerminalLinkPointerGesture(event, platform) && !event.shiftKey) return 'link'
  return 'select'
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  viewportRows: number,
  remainder: number
): { readonly rows: number; readonly remainder: number } {
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY
  const total = remainder + pixels / cellHeight
  const rows = Math.trunc(total)
  return { rows, remainder: total - rows }
}

export const MAX_WHEEL_ARROW_ROWS = 5

export function terminalWheelAction(
  event: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'deltaY'>,
  state: { mouseTracking: boolean; alternateScreen: boolean; focused: boolean }
): 'native' | 'report' | 'arrows' | 'scroll' {
  if (event.deltaY === 0) return 'native'
  if (event.ctrlKey || event.metaKey) return 'native'
  if (shouldReportTerminalMouse(state.mouseTracking, event)) return 'report'
  if (state.alternateScreen) return state.focused ? 'arrows' : 'native'
  return 'scroll'
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return ''
  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? '\u001bOA'
        : '\u001b[A'
      : applicationCursorKeys
        ? '\u001bOB'
        : '\u001b[B'
  return sequence.repeat(Math.abs(rows))
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  platform = navigator.platform
): boolean {
  return isMacPlatform(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function shouldShowTerminalLinkHover(
  mouseTracking: boolean,
  linkModifierActive: boolean
): boolean {
  return !mouseTracking || linkModifierActive
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1
    case 1:
      return 3
    case 2:
      return 2
    case 3:
      return 4
    case 4:
      return 5
    default:
      return null
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number
  readonly time: number
  readonly x: number
  readonly y: number
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'timeStamp'>
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= 500 &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY
  }
}

function measureMountBox(
  mount: HTMLElement,
  canvas: HTMLCanvasElement
): { readonly width: number; readonly height: number } {
  const rect = canvas.getBoundingClientRect()
  const width = rect.width || canvas.clientWidth || mount.clientWidth
  const height = rect.height || canvas.clientHeight || mount.clientHeight
  return { width, height }
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number }
  readonly end: { readonly x: number; readonly y: number }
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme
  readonly font?: GhosttyTerminalFont
  readonly onData: (data: string) => void
  readonly onResize: (cols: number, rows: number) => void
  readonly onSelectionChange: () => void
  readonly beforeKey: (event: KeyboardEvent) => boolean
  readonly onLinkActivate: (text: string, event: MouseEvent) => void
  readonly onContextMenu?: (event: MouseEvent) => void
  readonly resolveLink?: (
    rows: GhosttySnapshot['rowData'],
    rowIndex: number,
    column: number
  ) => TerminalLinkWithRange | null
  readonly cursorBlink?: boolean
  readonly maxScrollbackLines?: number
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement
  readonly input: HTMLTextAreaElement
  readonly scrollbar: HTMLDivElement
  cols = 1
  rows = 1

  private readonly mount: HTMLElement
  private readonly context: CanvasRenderingContext2D
  private readonly core: GhosttyTerminalCore
  private readonly options: GhosttyTerminalSurfaceOptions
  private metrics: GhosttyCellMetrics
  private fontFamily: string
  private requestedFontFamily: string | undefined
  private fontSize: number
  private lineHeight: number
  private fontEpoch = 0
  private pendingFontEpoch: number | null = null
  private readonly resizeObserver: ResizeObserver
  private readonly scrollbarThumb: HTMLDivElement
  private snapshot: GhosttySnapshot | null = null
  private frame = 0
  private paused = false
  private cursorTimer: number | null = null
  private compositionInputToSuppress: string | null = null
  private compositionSuppressionTimer: number | null = null
  private cursorOn = true
  private renderedCursorY: number | null = null
  private renderedBackground: GhosttyColor | null = null
  private forceFullRender = true
  private scrollbarDirty = true
  private scrollbarStateValue: GhosttyScrollbar | null = null
  private scrollbarPointerId: number | null = null
  private scrollbarPointerOffset = 0
  private disposed = false
  private resizeNotifyTimer: number | null = null
  private originY = CONTENT_PADDING
  private mountHeight = 0
  private selectionEnd: { x: number; y: number } | null = null
  private selectionAnchorScreen: { x: number; y: number } | null = null
  private selectionEndScreen: { x: number; y: number } | null = null
  private selectionMode: 'cell' | 'word' | 'line' = 'cell'
  private selectionBase: {
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | null = null
  private selectionScrollTimer: number | null = null
  private selectionScrollDelta = 0
  private selectionPointer: { x: number; y: number } | null = null
  private mouseReportingPointerId: number | null = null
  private mouseReportingButton: number | null = null
  private linkActivationPointerId: number | null = null
  private selectionPointerId: number | null = null
  private hoveredLink: TerminalLinkWithRange | null = null
  private hoverPointer: { x: number; y: number } | null = null
  private linkModifierActive = false
  private selectionClickSequence: TerminalSelectionClickSequence | null = null
  private selectionMoved = false
  private composing = false
  private focused = false
  private resizeNotified = false
  private canvasConfigured = false
  private theme: GhosttyTheme
  private readonly suppressedKeyCodes = new Set<string>()
  private pasteShortcutToken = 0
  private copyShortcutToken = 0
  private clearSelectionAfterCopy = false
  private wheelRemainder = 0
  private dprMedia: MediaQueryList | null = null
  private readonly reducedMotionMedia = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  private inputLeft = -1
  private inputTop = -1

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    scrollbar: HTMLDivElement,
    scrollbarThumb: HTMLDivElement,
    context: CanvasRenderingContext2D,
    core: GhosttyTerminalCore,
    metrics: GhosttyCellMetrics,
    fontFamily: string,
    options: GhosttyTerminalSurfaceOptions
  ) {
    this.mount = mount
    this.canvas = canvas
    this.input = input
    this.scrollbar = scrollbar
    this.scrollbarThumb = scrollbarThumb
    this.context = context
    this.core = core
    this.metrics = metrics
    this.options = options
    this.theme = options.theme
    this.fontFamily = fontFamily
    this.requestedFontFamily = options.font?.family
    this.fontSize = terminalFontSize(options.font?.size)
    this.lineHeight = terminalLineHeight(options.font?.lineHeight)
    this.resizeObserver = new ResizeObserver(() => this.fit())
    this.installEvents()
    this.watchDevicePixelRatio()
    this.reducedMotionMedia?.addEventListener('change', this.onReducedMotionChange)
    document.fonts.addEventListener('loadingdone', this.onFontsLoaded)
    this.resizeObserver.observe(mount)
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions
  ): Promise<GhosttyTerminalSurface> {
    const canvas = document.createElement('canvas')
    canvas.dataset.testid = 'ghostty-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:text;'

    const input = document.createElement('textarea')
    input.className = 'tr-ghostty-input'
    input.setAttribute('aria-label', 'Terminal input')
    input.autocapitalize = 'off'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.style.cssText =
      'position:absolute;left:4px;top:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;'

    const scrollbar = document.createElement('div')
    scrollbar.dataset.testid = 'ghostty-scrollbar'
    scrollbar.setAttribute('role', 'scrollbar')
    scrollbar.setAttribute('aria-label', 'Terminal scrollback')
    scrollbar.setAttribute('aria-orientation', 'vertical')
    scrollbar.tabIndex = 0
    scrollbar.hidden = true
    scrollbar.style.cssText =
      'position:absolute;top:4px;right:1px;bottom:4px;z-index:var(--z-base);width:6px;cursor:default;touch-action:none;'
    const scrollbarThumb = document.createElement('div')
    scrollbarThumb.style.cssText =
      'position:absolute;left:0;right:0;top:0;border-radius:3px;background:transparent;transition:background-color 120ms ease-out;'
    scrollbar.addEventListener('pointerenter', () => {
      scrollbarThumb.style.background = 'var(--border)'
    })
    scrollbar.addEventListener('pointerleave', () => {
      scrollbarThumb.style.background = 'transparent'
    })
    scrollbar.append(scrollbarThumb)
    mount.replaceChildren(canvas, input, scrollbar)
    if (window.getComputedStyle(mount).position === 'static') {
      mount.style.position = 'relative'
    }

    const context = canvas.getContext('2d', { alpha: true })
    if (!context) {
      throw new Error(
        `ghostty surface: Canvas 2D is unavailable on mount ${mount.className || '(unclassed)'}`
      )
    }
    const fontSize = terminalFontSize(options.font?.size)
    const fontFamily = await loadTerminalFontFamily(options.font?.family, fontSize)
    const lineHeight = terminalLineHeight(options.font?.lineHeight)
    const metrics = measureGhosttyCell(
      context,
      fontSize,
      fontFamily,
      window.devicePixelRatio || 1,
      lineHeight
    )
    const box = measureMountBox(mount, canvas)
    const grid = terminalGridSize(box.width, box.height, metrics, CONTENT_PADDING)
    const core = await GhosttyTerminalCore.create(
      grid.cols,
      grid.rows,
      metrics.width,
      metrics.height,
      options.theme,
      options.onData,
      undefined,
      {
        defaultCursorBlink: options.cursorBlink ?? true,
        maxScrollback:
          options.maxScrollbackLines !== undefined
            ? scrollbackLinesToBytes(options.maxScrollbackLines, grid.cols)
            : undefined
      }
    )
    const surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      scrollbar,
      scrollbarThumb,
      context,
      core,
      metrics,
      fontFamily,
      options
    )
    surface.fit()
    surface.requestRender()
    return surface
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) return
    const startedAt = performance.now()
    this.core.write(data)
    paintStats.parseMs += performance.now() - startedAt
    paintStats.parseCalls += 1
    paintStats.parseBytes += typeof data === 'string' ? data.length : data.byteLength
    this.cursorOn = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  resetAndWrite(data: string): void {
    if (this.disposed) return
    this.core.resetAndWrite(data)
    this.cursorOn = true
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  snapshotFormatVersion(): number {
    return this.core.snapshotFormatVersion()
  }

  importSnapshot(state: Uint8Array): boolean {
    if (this.disposed) return false
    const imported = this.core.importSnapshot(state)
    const grid = imported ? this.core.gridSize() : null
    const usable = grid === null ? false : grid.cols === this.cols && grid.rows === this.rows
    if (imported && !usable) {
      this.core.resetAndWrite('')
      this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height)
    }
    this.cursorOn = true
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
    return usable
  }

  repaint(): void {
    if (this.disposed) return
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  /** A lost GPU context comes back blank with the DPR transform reset, and
   * an idle pane has nothing dirty to redraw it. Clearing `canvasConfigured`
   * makes `fit` re-apply the transform at an unchanged measured size. */
  private readonly onContextRestored = (): void => {
    if (this.disposed) return
    this.canvasConfigured = false
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.fit()
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed) return
    this.theme = theme
    this.core.setTheme(theme)
    this.renderedBackground = syncCanvasBackground(this.canvas, this.renderedBackground, theme.background)
    this.forceFullRender = true
    this.requestRender()
  }

  setDefaultCursorBlink(enabled: boolean): void {
    if (this.disposed) return
    this.core.setDefaultCursorBlink(enabled)
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return
    const fontSize = terminalFontSize(font.size)
    const lineHeight =
      font.lineHeight !== undefined ? terminalLineHeight(font.lineHeight) : this.lineHeight
    const epoch = ++this.fontEpoch
    this.pendingFontEpoch = epoch
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize)
    if (this.disposed || epoch !== this.fontEpoch) return
    this.pendingFontEpoch = null
    this.fontFamily = fontFamily
    this.requestedFontFamily = font.family
    this.fontSize = fontSize
    this.lineHeight = lineHeight
    this.applyFontMetrics()
  }

  private applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(
      this.context,
      this.fontSize,
      this.fontFamily,
      window.devicePixelRatio || 1,
      this.lineHeight
    )
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height)
    this.inputLeft = -1
    this.inputTop = -1
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.fit()
    this.requestRender()
  }

  private readonly onReducedMotionChange = (): void => {
    if (this.disposed) return
    this.cursorOn = true
    this.requestRender()
  }

  private readonly onFontsLoaded = (): void => {
    if (this.disposed) return
    if (this.pendingFontEpoch !== null) return
    const fontFamily = terminalFontFamily(this.requestedFontFamily)
    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily
      this.applyFontMetrics()
      return
    }
    const metrics = measureGhosttyCell(
      this.context,
      this.fontSize,
      this.fontFamily,
      window.devicePixelRatio || 1,
      this.lineHeight
    )
    if (
      metrics.width === this.metrics.width &&
      metrics.height === this.metrics.height &&
      metrics.baseline === this.metrics.baseline
    ) {
      return
    }
    this.applyFontMetrics()
  }

  fit(): boolean {
    if (this.disposed) return false
    const box = measureMountBox(this.mount, this.canvas)
    const width = box.width
    const height = box.height
    if (width <= 0 || height <= 0) return false
    // `terminalGridSize` would clamp a collapsed viewport to 1x1, a size no
    // user made: the CLI would redraw its whole screen into a one-column box
    // and again on the way back. Keep the last size that was real.
    if (!boxFitsOneCell(width, height, this.metrics, CONTENT_PADDING)) {
      return false
    }
    const ratio = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.round(width * ratio))
    const pixelHeight = Math.max(1, Math.round(height * ratio))
    let shouldRender = false
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured
    ) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
      this.context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
      this.canvasConfigured = true
      this.forceFullRender = true
      this.scrollbarDirty = true
      shouldRender = true
    }
    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING)
    this.mountHeight = height
    if (grid.cols !== this.cols || grid.rows !== this.rows || !this.resizeNotified) {
      this.cols = grid.cols
      this.rows = grid.rows
      this.core.resize(grid.cols, grid.rows, this.metrics.width, this.metrics.height)
      this.notifyResize()
      this.forceFullRender = true
      this.scrollbarDirty = true
      shouldRender = true
    }
    if (shouldRender) this.renderFrame()
    return true
  }

  private notifyResize(): void {
    this.resizeNotified = true
    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer)
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null
      if (!this.disposed) this.options.onResize(this.cols, this.rows)
    }, RESIZE_NOTIFY_DEBOUNCE_MS)
  }

  focus(): void {
    this.input.focus({ preventScroll: true })
  }

  blur(): void {
    this.input.blur()
  }

  async pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const token = ++this.pasteShortcutToken
    const text = await readText()
    if (this.disposed || this.pasteShortcutToken !== token || !isCurrent()) return
    this.pasteShortcutToken += 1
    if (text.length === 0) return
    const encoded = this.core.encodePaste(text)
    if (encoded.length > 0) this.options.onData(encoded)
  }

  paste(text: string): void {
    if (this.disposed || text.length === 0) return
    this.pasteShortcutToken += 1
    const encoded = this.core.encodePaste(text)
    if (encoded.length > 0) this.options.onData(encoded)
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0
  }

  getSelection(): string {
    return this.core.selectionText()
  }

  getBufferText(): string {
    const anchor = this.selectionAnchorScreen
    const end = this.selectionEndScreen
    this.core.selectAll()
    const text = this.core.selectionText()
    if (anchor && end) {
      this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 })
    } else {
      this.core.clearSelection()
    }
    this.forceFullRender = true
    this.requestRender()
    return text
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.hasSelection()) return null
    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x)
    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen }
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const position = this.getSelectionPosition()
    if (!position) return null
    const viewportEnd = this.core.screenPointToViewport(position.end.x, position.end.y)
    if (!viewportEnd) return null
    const bounds = this.canvas.getBoundingClientRect()
    return {
      right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * this.metrics.width,
      bottom: bounds.top + this.originY + (viewportEnd.y + 1) * this.metrics.height
    }
  }

  clearSelection(): void {
    this.core.clearSelection()
    this.selectionEnd = null
    this.selectionAnchorScreen = null
    this.selectionEndScreen = null
    this.selectionMode = 'cell'
    this.selectionBase = null
    this.setSelectionAutoscroll(0)
    this.options.onSelectionChange()
    this.forceFullRender = true
    this.requestRender()
  }

  selectAll(): void {
    this.core.selectAll()
    this.forceFullRender = true
    this.options.onSelectionChange()
    this.requestRender()
  }

  scrollToBottom(): void {
    this.core.scrollToBottom()
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive()
  }

  bufferRowCount(): number {
    return this.core.scrollbarState()?.total ?? this.rows
  }

  currentSnapshot(): GhosttySnapshot | null {
    return this.snapshot
  }

  isAlternateScreen(): boolean {
    return this.core.isAlternateScreen()
  }

  isMouseTracking(): boolean {
    return this.core.isMouseTracking()
  }

  isApplicationCursorKeys(): boolean {
    return this.core.isApplicationCursorKeys()
  }

  refreshHover(): void {
    if (this.disposed) return
    this.refreshHoveredLink()
  }

  scrollbarState(): GhosttyScrollbar | null {
    return this.core.scrollbarState()
  }

  withScreenReader<T>(read: (readRow: (y: number) => string) => T): T {
    const anchor = this.selectionAnchorScreen
    const end = this.selectionEndScreen
    const lastColumn = Math.max(0, this.cols - 1)
    try {
      return read((y: number) => {
        if (y < 0) return ''
        this.core.setSelection({ x: 0, y, tag: 2 }, { x: lastColumn, y, tag: 2 })
        return this.core.selectionText()
      })
    } finally {
      if (anchor && end) {
        this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 })
      } else {
        this.core.clearSelection()
      }
      this.forceFullRender = true
      this.requestRender()
    }
  }

  selectScreenRange(
    start: { x: number; y: number },
    end: { x: number; y: number }
  ): void {
    if (this.disposed) return
    this.core.setSelection({ ...start, tag: 2 }, { ...end, tag: 2 })
    this.selectionAnchorScreen = start
    this.selectionEndScreen = end
    this.selectionBase = null
    this.selectionMode = 'cell'
    this.options.onSelectionChange()
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  revealScreenRow(y: number): void {
    if (this.disposed) return
    const state = this.core.scrollbarState()
    if (state === null) return
    if (y >= state.offset && y < state.offset + state.len) return
    const centred = Math.round(y - state.len / 2)
    this.scrollViewport(centred - state.offset)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resizeObserver.disconnect()
    document.fonts.removeEventListener('loadingdone', this.onFontsLoaded)
    this.dprMedia?.removeEventListener('change', this.onDevicePixelRatioChange)
    this.dprMedia = null
    this.reducedMotionMedia?.removeEventListener('change', this.onReducedMotionChange)
    if (this.selectionScrollTimer !== null) window.clearInterval(this.selectionScrollTimer)
    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer)
      this.resizeNotifyTimer = null
      this.options.onResize(this.cols, this.rows)
    }
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame)
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer)
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer)
    }
    this.removeEvents()
    this.core.dispose()
    if (
      this.canvas.parentElement === this.mount ||
      this.input.parentElement === this.mount ||
      this.scrollbar.parentElement === this.mount
    ) {
      this.canvas.remove()
      this.input.remove()
      this.scrollbar.remove()
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.updateLinkModifier(event)
    if (isTerminalAltGraphText(event) || !this.options.beforeKey(event)) {
      this.suppressedKeyCodes.add(event.code)
      return
    }
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      if (event.shiftKey) {
        event.preventDefault()
        document.execCommand('copy')
      } else {
        this.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform()
        const clipboard = navigator.clipboard
        if (typeof clipboard?.writeText === 'function') {
          const token = ++this.copyShortcutToken
          const selection = this.getSelection()
          void Promise.resolve().then(() => {
            if (this.disposed || this.copyShortcutToken !== token) return
            void clipboard.writeText(selection).then(
              () => {
                if (this.disposed || this.copyShortcutToken !== token) return
                if (this.clearSelectionAfterCopy) {
                  this.clearSelectionAfterCopy = false
                  this.clearSelection()
                }
              },
              () => {
                if (this.copyShortcutToken === token) {
                  this.clearSelectionAfterCopy = false
                }
              }
            )
          })
        }
      }
      this.suppressedKeyCodes.add(event.code)
      return
    }
    if (isTerminalPasteShortcut(event)) {
      this.suppressedKeyCodes.add(event.code)
      const clipboard = navigator.clipboard
      if (typeof clipboard?.readText === 'function') {
        const token = ++this.pasteShortcutToken
        void clipboard.readText().then(
          (text) => {
            if (this.disposed || this.pasteShortcutToken !== token) return
            this.pasteShortcutToken += 1
            if (text.length > 0) this.options.onData(this.core.encodePaste(text))
          },
          () => {
          }
        )
      }
      return
    }
    if (event.isComposing || this.composing || event.key === 'Process' || event.keyCode === 229) {
      return
    }
    const data = this.core.encodeKey(event)
    if (data.length === 0) return
    this.suppressedKeyCodes.delete(event.code)
    event.preventDefault()
    event.stopPropagation()
    this.options.onData(data)
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.updateLinkModifier(event)
    const suppressed = this.suppressedKeyCodes.delete(event.code)
    const verdict = decideKeyRelease({
      claimedByPane: !this.options.beforeKey(event),
      pressWasSuppressed: suppressed,
      isComposingTail:
        event.isComposing || this.composing || event.key === 'Process' || event.keyCode === 229,
      encodeRelease: () => this.core.encodeKey(event, 'release')
    })
    switch (verdict.action) {
      case 'consumed-by-pane':
        event.preventDefault()
        event.stopPropagation()
        return
      case 'swallow':
        return
      case 'ignored':
        return
      case 'send':
        event.preventDefault()
        event.stopPropagation()
        this.options.onData(verdict.data)
        return
    }
  }

  private readonly onFocus = (): void => {
    this.focused = true
    this.cursorOn = true
    this.requestRender()
  }

  private readonly onBlur = (): void => {
    this.focused = false
    this.linkModifierActive = false
    this.refreshHoveredLink()
    this.cursorOn = true
    this.requestRender()
  }

  private readonly onDevicePixelRatioChange = (): void => {
    this.watchDevicePixelRatio()
    this.metrics = measureGhosttyCell(
      this.context,
      this.fontSize,
      this.fontFamily,
      window.devicePixelRatio || 1,
      this.lineHeight
    )
    this.forceFullRender = true
    this.fit()
  }

  private watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener('change', this.onDevicePixelRatioChange)
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.dprMedia.addEventListener('change', this.onDevicePixelRatioChange)
  }

  private readonly onCopyEvent = (event: ClipboardEvent): void => {
    if (!this.hasSelection()) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', this.getSelection())
    this.copyShortcutToken += 1
    if (this.clearSelectionAfterCopy) {
      this.clearSelectionAfterCopy = false
      this.clearSelection()
    }
  }

  private readonly onPaste = (event: ClipboardEvent): void => {
    event.preventDefault()
    const data = event.clipboardData?.getData('text/plain') ?? ''
    if (data.length === 0) return
    this.pasteShortcutToken += 1
    this.options.onData(this.core.encodePaste(data))
  }

  private readonly onCompositionStart = (): void => {
    this.clearCompositionInputSuppression()
    this.composing = true
  }

  private readonly onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false
    const data = this.input.value || event.data
    if (data.length > 0) this.options.onData(data)
    this.input.value = ''
    this.compositionInputToSuppress = data
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null
      this.compositionSuppressionTimer = null
    }, COMPOSITION_SUPPRESSION_MS)
  }

  private readonly onInput = (event: Event): void => {
    const inputEvent = event as InputEvent
    if (this.composing || inputEvent.isComposing) return
    const data = this.input.value || inputEvent.data || ''
    const verdict = decideCompositionInput(this.compositionInputToSuppress, data, inputEvent)
    this.clearCompositionInputSuppression()
    if (verdict.deliver) this.options.onData(data)
    this.input.value = ''
  }

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer)
      this.compositionSuppressionTimer = null
    }
    this.compositionInputToSuppress = null
  }

  private capturePointer(element: Element, pointerId: number): void {
    try {
      element.setPointerCapture(pointerId)
    } catch {
    }
  }

  private releasePointer(element: Element, pointerId: number): void {
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    } catch {
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.focus()
    const intent = terminalPointerDownIntent(event, {
      mouseTracking: this.core.isMouseTracking(),
      alternateScreen: this.core.isAlternateScreen()
    })
    if (intent === 'report') {
      const button = ghosttyMouseButton(event.button)
      if (button === null) return
      event.preventDefault()
      event.stopPropagation()
      this.clearHoveredLink('default')
      this.mouseReportingPointerId = event.pointerId
      this.mouseReportingButton = button
      this.sendMouse('press', button, event)
      this.capturePointer(this.canvas, event.pointerId)
      return
    }
    if (intent === 'ignore') return
    if (intent === 'tui-drag-copy') return
    if (intent === 'link') {
      event.preventDefault()
      event.stopPropagation()
      this.linkActivationPointerId = event.pointerId
      this.capturePointer(this.canvas, event.pointerId)
      return
    }
    this.clearHoveredLink()
    const cell = this.cellAt(event.clientX, event.clientY)
    this.selectionMoved = false
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event
    )
    const clickCount = this.selectionClickSequence.count
    this.selectionMode = clickCount >= 3 ? 'line' : clickCount === 2 ? 'word' : 'cell'
    const range =
      this.selectionMode === 'line'
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === 'word'
          ? this.core.selectWord(cell.x, cell.y)
          : null
    if (range) {
      this.selectionBase = range.screen
      this.selectionEnd = range.viewport.end
      this.selectionAnchorScreen = range.screen.start
      this.selectionEndScreen = range.screen.end
      this.options.onSelectionChange()
    } else {
      this.selectionMode = 'cell'
      this.selectionBase = null
      this.selectionEnd = cell
      const screen = this.core.viewportPointToScreen(cell.x, cell.y)
      this.selectionAnchorScreen = screen
      this.selectionEndScreen = screen
      if (screen) {
        this.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 })
      } else {
        this.core.setSelection(cell, cell)
      }
    }
    this.forceFullRender = true
    this.selectionPointerId = event.pointerId
    this.requestRender()
    this.capturePointer(this.canvas, event.pointerId)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.linkActivationPointerId === event.pointerId) return
    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(this.core.isMouseAnyEventTracking(), event)
    ) {
      event.preventDefault()
      this.hoverPointer = { x: event.clientX, y: event.clientY }
      this.linkModifierActive = isTerminalLinkPointerGesture(event)
      this.setHoveredLink(null)
      this.canvas.style.cursor = 'default'
      this.sendMouse('motion', this.buttonFromButtons(event.buttons), event)
      return
    }
    if (this.selectionPointerId === event.pointerId && (event.buttons & 1) === 0) {
      this.selectionPointerId = null
      this.setSelectionAutoscroll(0)
    }
    if (this.selectionPointerId !== event.pointerId || !this.selectionAnchorScreen) {
      this.updateHoverCursor(event)
      return
    }
    this.clearHoveredLink()
    this.selectionPointer = { x: event.clientX, y: event.clientY }
    const bounds = this.canvas.getBoundingClientRect()
    this.setSelectionAutoscroll(
      event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0
    )
    const cell = this.cellAt(event.clientX, event.clientY)
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return
    this.extendSelectionTo(event.clientX, event.clientY)
  }

  private extendSelectionTo(clientX: number, clientY: number): void {
    const anchorScreen = this.selectionAnchorScreen
    if (anchorScreen === null) return
    const cell = this.cellAt(clientX, clientY)
    this.selectionMoved = true
    this.selectionEnd = cell
    const range =
      this.selectionMode === 'line'
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === 'word'
          ? this.core.selectWord(cell.x, cell.y)
          : null
    const cellScreen = this.core.viewportPointToScreen(cell.x, cell.y)
    if (cellScreen === null) return
    const base = this.selectionBase
    const beforeBase =
      base !== null &&
      (cellScreen.y < base.start.y ||
        (cellScreen.y === base.start.y && cellScreen.x < base.start.x))
    const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start
    const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end
    this.selectionAnchorScreen = anchor
    this.selectionEndScreen = end
    this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 })
    this.options.onSelectionChange()
    this.forceFullRender = true
    this.requestRender()
  }

  private setSelectionAutoscroll(delta: number): void {
    this.selectionScrollDelta = delta
    if (delta === 0) {
      if (this.selectionScrollTimer !== null) {
        window.clearInterval(this.selectionScrollTimer)
        this.selectionScrollTimer = null
      }
      return
    }
    if (this.selectionScrollTimer !== null) return
    this.selectionScrollTimer = window.setInterval(() => {
      if (this.disposed || this.selectionScrollDelta === 0) return
      this.scrollViewport(this.selectionScrollDelta)
      const pointer = this.selectionPointer
      if (pointer) this.extendSelectionTo(pointer.x, pointer.y)
    }, SELECTION_AUTOSCROLL_INTERVAL_MS)
  }

  private updateHoverCursor(event: PointerEvent): void {
    this.hoverPointer = { x: event.clientX, y: event.clientY }
    this.linkModifierActive = isTerminalLinkPointerGesture(event)
    this.refreshHoveredLink()
  }

  private updateLinkModifier(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): void {
    const active = isTerminalLinkPointerGesture(event)
    if (active === this.linkModifierActive) return
    this.linkModifierActive = active
    this.refreshHoveredLink()
  }

  private readonly onPointerLeave = (): void => {
    this.clearHoveredLink()
  }

  private clearHoveredLink(cursor = ''): void {
    this.hoverPointer = null
    this.setHoveredLink(null)
    this.canvas.style.cursor = cursor
  }

  private refreshHoveredLink(): void {
    const pointer = this.hoverPointer
    const link =
      pointer && shouldShowTerminalLinkHover(this.core.isMouseTracking(), this.linkModifierActive)
        ? this.linkAt(pointer.x, pointer.y)
        : null
    this.setHoveredLink(link)
  }

  private refreshHoveredLinkForFrame(dirtyRows: ReadonlySet<number>): void {
    if (this.hoverPointer === null) {
      if (this.hoveredLink !== null) this.setHoveredLink(null)
      return
    }
    if (dirtyRows.size === 0 && !this.forceFullRender) return
    this.refreshHoveredLink()
  }

  private setHoveredLink(link: TerminalLinkWithRange | null): void {
    const previous = this.hoveredLink
    const unchanged =
      previous?.text === link?.text &&
      previous?.range.start.x === link?.range.start.x &&
      previous?.range.start.y === link?.range.start.y &&
      previous?.range.end.x === link?.range.end.x &&
      previous?.range.end.y === link?.range.end.y
    if (unchanged) return
    this.canvas.style.cursor = link ? 'pointer' : ''
    this.hoveredLink = link
    this.forceFullRender = true
    this.requestRender()
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.setSelectionAutoscroll(0)
    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.linkActivationPointerId = null
      this.releasePointer(this.canvas, event.pointerId)
      if (event.type !== 'pointercancel') {
        const link = this.linkAt(event.clientX, event.clientY)
        if (link) this.options.onLinkActivate(link.text, event)
      }
      return
    }
    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      this.sendMouse('release', this.mouseReportingButton, event)
      this.mouseReportingPointerId = null
      this.mouseReportingButton = null
      this.releasePointer(this.canvas, event.pointerId)
      if (event.type === 'pointercancel') {
        this.clearHoveredLink()
      } else {
        this.hoverPointer = { x: event.clientX, y: event.clientY }
        this.linkModifierActive = isTerminalLinkPointerGesture(event)
        this.refreshHoveredLink()
      }
      return
    }
    this.releasePointer(this.canvas, event.pointerId)
    if (this.selectionPointerId === event.pointerId) this.selectionPointerId = null
    if (event.button !== 0) return
    if (!this.selectionMoved && this.selectionMode === 'cell') {
      this.clearSelection()
    }
    this.options.onSelectionChange()
  }

  private readonly onWheel = (event: WheelEvent): void => {
    const action = terminalWheelAction(event, {
      mouseTracking: this.core.isMouseTracking(),
      alternateScreen: this.core.isAlternateScreen(),
      focused: this.focused
    })
    if (action === 'native') return
    event.preventDefault()
    const delta = terminalWheelDeltaRows(event, this.metrics.height, this.rows, this.wheelRemainder)
    this.wheelRemainder = delta.remainder
    if (delta.rows === 0) return
    if (action === 'report') {
      const button = delta.rows < 0 ? 4 : 5
      const magnitude = Math.abs(delta.rows)
      for (let index = 0; index < magnitude; index += 1) {
        this.sendMouse('press', button, event)
      }
      return
    }
    if (action === 'arrows') {
      const rows = Math.sign(delta.rows) * Math.min(Math.abs(delta.rows), MAX_WHEEL_ARROW_ROWS)
      this.options.onData(terminalWheelArrowData(rows, this.core.isApplicationCursorKeys()))
      return
    }
    this.scrollViewport(delta.rows)
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 0) event.preventDefault()
    this.focus()
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      event.preventDefault()
      return
    }
    this.options.onContextMenu?.(event)
  }

  private readonly onScrollbarPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const state = this.readScrollbarState()
    if (state === null) return
    const bounds = this.scrollbar.getBoundingClientRect()
    const geometry = terminalScrollbarGeometry(state, bounds.height)
    if (geometry === null) return
    event.preventDefault()
    event.stopPropagation()
    this.scrollbarPointerId = event.pointerId
    this.scrollbarPointerOffset =
      event.target === this.scrollbarThumb
        ? event.clientY - bounds.top - geometry.thumbTop
        : geometry.thumbHeight / 2
    this.capturePointer(this.scrollbar, event.pointerId)
    this.scrollbarToPointer(event.clientY, bounds)
  }

  private readonly onScrollbarPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarStateValue === null) return
    event.preventDefault()
    this.scrollbarToPointer(event.clientY, this.scrollbar.getBoundingClientRect())
  }

  private readonly onScrollbarPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.scrollbarPointerId) return
    event.preventDefault()
    this.scrollbarPointerId = null
    this.releasePointer(this.scrollbar, event.pointerId)
  }

  private readonly onScrollbarKeyDown = (event: KeyboardEvent): void => {
    const state = this.readScrollbarState()
    if (state === null) return
    let delta = 0
    switch (event.key) {
      case 'ArrowUp':
        delta = -1
        break
      case 'ArrowDown':
        delta = 1
        break
      case 'PageUp':
        delta = -Math.max(1, state.len)
        break
      case 'PageDown':
        delta = Math.max(1, state.len)
        break
      case 'Home':
        delta = -state.offset
        break
      case 'End':
        delta = state.total - state.len - state.offset
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    this.scrollViewport(delta)
  }

  private installEvents(): void {
    this.input.addEventListener('keydown', this.onKeyDown)
    this.input.addEventListener('keyup', this.onKeyUp)
    this.input.addEventListener('focus', this.onFocus)
    this.input.addEventListener('blur', this.onBlur)
    this.input.addEventListener('input', this.onInput)
    this.input.addEventListener('paste', this.onPaste)
    this.input.addEventListener('copy', this.onCopyEvent)
    this.input.addEventListener('compositionstart', this.onCompositionStart)
    this.input.addEventListener('compositionend', this.onCompositionEnd)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerleave', this.onPointerLeave)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('contextrestored', this.onContextRestored)
    this.scrollbar.addEventListener('pointerdown', this.onScrollbarPointerDown)
    this.scrollbar.addEventListener('pointermove', this.onScrollbarPointerMove)
    this.scrollbar.addEventListener('pointerup', this.onScrollbarPointerUp)
    this.scrollbar.addEventListener('pointercancel', this.onScrollbarPointerUp)
    this.scrollbar.addEventListener('keydown', this.onScrollbarKeyDown)
  }

  private removeEvents(): void {
    this.input.removeEventListener('keydown', this.onKeyDown)
    this.input.removeEventListener('keyup', this.onKeyUp)
    this.input.removeEventListener('focus', this.onFocus)
    this.input.removeEventListener('blur', this.onBlur)
    this.input.removeEventListener('input', this.onInput)
    this.input.removeEventListener('paste', this.onPaste)
    this.input.removeEventListener('copy', this.onCopyEvent)
    this.input.removeEventListener('compositionstart', this.onCompositionStart)
    this.input.removeEventListener('compositionend', this.onCompositionEnd)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('contextrestored', this.onContextRestored)
    this.scrollbar.removeEventListener('pointerdown', this.onScrollbarPointerDown)
    this.scrollbar.removeEventListener('pointermove', this.onScrollbarPointerMove)
    this.scrollbar.removeEventListener('pointerup', this.onScrollbarPointerUp)
    this.scrollbar.removeEventListener('pointercancel', this.onScrollbarPointerUp)
    this.scrollbar.removeEventListener('keydown', this.onScrollbarKeyDown)
  }

  private scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows)
    const state = this.readScrollbarState()
    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len)
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset))
      delta = offset - state.offset
      this.scrollbarStateValue = { ...state, offset }
    }
    if (delta === 0) return
    this.core.scroll(delta)
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  scroll(deltaRows: number): void {
    if (this.disposed) return
    this.scrollViewport(deltaRows)
  }

  private scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    const state = this.scrollbarStateValue
    if (state === null) return
    const offset = terminalScrollbarOffsetAtPointer(
      state,
      bounds.height,
      clientY - bounds.top,
      this.scrollbarPointerOffset
    )
    this.scrollViewport(offset - state.offset)
  }

  private updateScrollbar(): void {
    const state = this.readScrollbarState()
    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, measureMountBox(this.mount, this.canvas).height - CONTENT_PADDING * 2)
          )
    this.scrollbar.hidden = geometry === null
    if (state === null || geometry === null) return
    this.scrollbar.setAttribute('aria-valuemin', '0')
    this.scrollbar.setAttribute('aria-valuemax', String(geometry.maxOffset))
    this.scrollbar.setAttribute(
      'aria-valuenow',
      String(Math.max(0, Math.min(state.offset, geometry.maxOffset)))
    )
    this.scrollbarThumb.style.height = `${geometry.thumbHeight}px`
    this.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`
  }

  private readScrollbarState(): GhosttyScrollbar | null {
    const state = this.core.scrollbarState()
    this.scrollbarStateValue = state
    return state
  }

  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return
    this.paused = paused
    if (paused) {
      if (this.frame !== 0) {
        window.cancelAnimationFrame(this.frame)
        this.frame = 0
      }
      return
    }
    this.forceFullRender = true
    this.scrollbarDirty = true
    this.requestRender()
  }

  private requestRender(): void {
    if (this.disposed || this.paused) return
    if (this.frame !== 0) {
      paintStats.coalescedRenders += 1
      return
    }
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0
      this.renderFrame()
    })
  }

  private renderFrame(): void {
    if (this.disposed || this.paused) return
    const paintStartedAt = performance.now()
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    this.snapshot = this.core.snapshot()
    if (!this.blinkEnabled()) this.cursorOn = true
    const scrollState = this.readScrollbarState()
    const anchorBottom = scrollState !== null && scrollState.total > scrollState.len
    const nextOriginY = terminalContentOriginY(
      this.mountHeight,
      CONTENT_PADDING,
      this.rows,
      this.metrics.height,
      anchorBottom,
      window.devicePixelRatio || 1
    )
    if (nextOriginY !== this.originY) {
      this.originY = nextOriginY
      this.forceFullRender = true
    }
    this.refreshHoveredLinkForFrame(this.snapshot.dirtyRows)
    this.renderedBackground = syncCanvasBackground(
      this.canvas,
      this.renderedBackground,
      this.snapshot.background
    )
    renderGhosttySnapshot({
      context: this.context,
      snapshot: this.snapshot,
      metrics: this.metrics,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      padding: CONTENT_PADDING,
      originY: this.originY,
      forceFull: this.forceFullRender,
      cursorOn: this.cursorOn,
      previousCursorY: this.renderedCursorY,
      focused: this.focused,
      hoveredLinkRange: this.hoveredLink?.range ?? null,
      devicePixelRatio: window.devicePixelRatio || 1,
      ...(this.theme.selectionBackground !== undefined
        ? { selectionBackground: this.theme.selectionBackground }
        : {})
    })
    this.positionInput()
    this.renderedCursorY =
      this.cursorOn && this.snapshot.cursorVisible && this.snapshot.cursorY >= 0
        ? this.snapshot.cursorY
        : null
    if (this.scrollbarDirty) {
      this.scrollbarDirty = false
      this.updateScrollbar()
    }
    this.forceFullRender = false
    this.scheduleCursorBlink()
    paintStats.paintMs += performance.now() - paintStartedAt
    paintStats.paintFrames += 1
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer)
    this.cursorTimer = null
    if (!this.blinkEnabled()) return
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null
      this.cursorOn = !this.cursorOn
      this.requestRender()
    }, CURSOR_BLINK_INTERVAL_MS)
  }

  private blinkEnabled(): boolean {
    const snapshot = this.snapshot
    if (!snapshot) return false
    return shouldBlinkTerminalCursor({
      focused: this.focused,
      cursorBlinking: snapshot.cursorBlinking,
      cursorVisible: snapshot.cursorVisible,
      reducedMotion: this.reducedMotionMedia?.matches ?? false
    })
  }

  private positionInput(): void {
    const snapshot = this.snapshot
    if (!snapshot || !snapshot.cursorVisible || snapshot.cursorX < 0 || snapshot.cursorY < 0) {
      return
    }
    const left = CONTENT_PADDING + snapshot.cursorX * this.metrics.width
    const top = this.originY + snapshot.cursorY * this.metrics.height
    if (left === this.inputLeft && top === this.inputTop) return
    this.inputLeft = left
    this.inputTop = top
    this.input.style.left = `${left}px`
    this.input.style.top = `${top}px`
    this.input.style.height = `${this.metrics.height}px`
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(
          this.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.metrics.width)
        )
      ),
      y: Math.max(
        0,
        Math.min(
          this.rows - 1,
          Math.floor((clientY - bounds.top - this.originY) / this.metrics.height)
        )
      )
    }
  }

  private linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    if (!this.snapshot) return null
    const cell = terminalGridCellAt({
      bounds: this.canvas.getBoundingClientRect(),
      clientX,
      clientY,
      cols: this.cols,
      rows: this.rows,
      metrics: this.metrics,
      padding: CONTENT_PADDING,
      originY: this.originY
    })
    if (!cell) return null
    const explicitHyperlink = this.core.hyperlinkAt(cell.x, cell.y)
    if (explicitHyperlink) {
      const start = { ...cell }
      const end = { ...cell }
      for (;;) {
        const previous =
          start.x > 0
            ? { x: start.x - 1, y: start.y }
            : start.y > 0 && this.snapshot.rowData[start.y]?.isWrapContinuation
              ? { x: this.cols - 1, y: start.y - 1 }
              : null
        if (!previous || this.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink) break
        start.x = previous.x
        start.y = previous.y
      }
      for (;;) {
        const next =
          end.x + 1 < this.cols
            ? { x: end.x + 1, y: end.y }
            : end.y + 1 < this.rows && this.snapshot.rowData[end.y]?.wrapsToNext
              ? { x: 0, y: end.y + 1 }
              : null
        if (!next || this.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break
        end.x = next.x
        end.y = next.y
      }
      return { text: explicitHyperlink, range: { start, end } }
    }
    return (
      this.options.resolveLink?.(this.snapshot.rowData, cell.y, cell.x) ??
      terminalLinkAtPositionWithRange(this.snapshot.rowData, cell.y, cell.x)
    )
  }

  private sendMouse(
    action: 'press' | 'release' | 'motion',
    button: number | null,
    event: MouseEvent
  ): void {
    const bounds = this.canvas.getBoundingClientRect()
    const data = this.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
      paddingLeft: CONTENT_PADDING,
      paddingRight: CONTENT_PADDING,
      paddingTop: this.originY,
      paddingBottom: Math.max(0, bounds.height - this.originY - this.rows * this.metrics.height),
      anyButtonPressed: event.buttons !== 0
    })
    if (data.length > 0) this.options.onData(data)
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1
    if ((buttons & 4) !== 0) return 3
    if ((buttons & 2) !== 0) return 2
    if ((buttons & 8) !== 0) return 4
    if ((buttons & 16) !== 0) return 5
    return null
  }
}
