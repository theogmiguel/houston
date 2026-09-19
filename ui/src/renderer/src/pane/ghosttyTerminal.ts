import type { GhosttySnapshot, GhosttyTheme } from '../ghostty/core'
import type { GhosttyTerminalSurface, TerminalLinkWithRange } from '../ghostty/surface'
import { logTerminalTransport } from '../houston/latency'
import { findResyncStart } from './writeQueue'

export interface PaneBufferLine {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface PaneBuffer {
  readonly type: 'normal' | 'alternate'
  readonly viewportY: number
  readonly length: number
  getLine(y: number): PaneBufferLine | undefined
}

export interface PaneTerminalOptions {
  disableStdin?: boolean
  theme?: { background?: string; foreground?: string; cursor?: string }
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
  cursorBlink?: boolean
}

export interface PaneDisposable {
  dispose(): void
}

export interface PaneTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: { readonly active: PaneBuffer }
  readonly options: PaneTerminalOptions
  readonly modes: {
    readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    readonly applicationCursorKeysMode: boolean
  }
  readonly textarea: HTMLTextAreaElement | undefined
  write(data: string | Uint8Array, callback?: () => void): void
  paste(data: string): void
  clear(): void
  reset(): void
  importSnapshot(state: Uint8Array): boolean
  snapshotFormatVersion(): number | null
  refresh(start: number, end: number): void
  setPaused(paused: boolean): void
  focus(): void
  blur(): void
  dispose(): void
  hasSelection(): boolean
  getSelection(): string
  clearSelection(): void
  onSelectionChange(listener: () => void): PaneDisposable
  onData(listener: (data: string) => void): PaneDisposable
  onRender(listener: () => void): PaneDisposable
  registerLinkProvider(provider: PaneLinkProvider): PaneDisposable
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
}

export interface PaneLink {
  readonly text: string
  readonly range: {
    readonly start: { readonly x: number; readonly y: number }
    readonly end: { readonly x: number; readonly y: number }
  }
  activate(event: MouseEvent, text: string): void
}

export interface PaneLinkProvider {
  provideLinks(bufferLineNumber: number, callback: (links: PaneLink[] | undefined) => void): void
}

export interface GhosttyTerminalInit {
  readonly host: HTMLElement
  readonly theme: { background?: string; foreground?: string; cursor?: string }
  readonly fontFamily: string
  readonly fontSize: number
  readonly lineHeight?: number
  readonly cursorBlink?: boolean
  readonly maxScrollbackLines?: number
  readonly disableStdin: boolean
  readonly sessionId: number
  // Injected so the pane's dynamic-import gate stays the ONLY place that
  // pulls the engine into a chunk -- this module must never statically
  // import `ghostty/surface.ts` (bundle-budget.json's `forbiddenBootPaths`).
  readonly load: (
    host: HTMLElement,
    options: GhosttySurfaceCreateOptions
  ) => Promise<GhosttyTerminalSurface>
  readonly toGhosttyTheme: (theme: {
    background?: string
    foreground?: string
    cursor?: string
  }) => GhosttyTheme
  // Buffered output during attach hit the cap and the oldest was dropped.
  // Narrated out of band (a toast), never written into the stream -- inside
  // a full-screen TUI an inline marker would land mid-frame.
  readonly onAttachOverflow?: (totalDroppedBytes: number, capBytes: number) => void
  // Fires once the engine is live and has drained what queued during create.
  // Before this, no keystroke can reach the PTY however focused the pane
  // looks. Never fires if create throws.
  readonly onAttached?: () => void
}

export interface GhosttySurfaceCreateOptions {
  readonly theme: GhosttyTheme
  readonly font: { family: string; size: number; lineHeight?: number }
  readonly onData: (data: string) => void
  readonly onResize: (cols: number, rows: number) => void
  readonly onSelectionChange: () => void
  readonly beforeKey: (event: KeyboardEvent) => boolean
  readonly onLinkActivate: (text: string, event: MouseEvent) => void
  readonly resolveLink: (
    rows: GhosttySnapshot['rowData'],
    rowIndex: number,
    column: number
  ) => TerminalLinkWithRange | null
  readonly cursorBlink?: boolean
  readonly maxScrollbackLines?: number
}

const CLEAR_SEQUENCE = '\u001b[H\u001b[2J\u001b[3J'

const ATTACH_BUFFER_CAP_BYTES = 4 * 1024 * 1024

const WRITE_BURST_BUDGET_MS = 8

function writeBurstBudgetMs(): number {
  const override = (globalThis as { __TR_WRITE_BURST_BUDGET_MS?: unknown })
    .__TR_WRITE_BURST_BUDGET_MS
  return typeof override === 'number' && Number.isFinite(override) && override > 0
    ? override
    : WRITE_BURST_BUDGET_MS
}

const pendingYields: (() => void)[] = []
let yieldChannel: MessageChannel | null = null
function yieldToEventLoop(fn: () => void): void {
  if (typeof MessageChannel !== 'function') {
    setTimeout(fn, 0)
    return
  }
  if (yieldChannel === null) {
    yieldChannel = new MessageChannel()
    yieldChannel.port1.onmessage = () => {
      pendingYields.shift()?.()
    }
  }
  pendingYields.push(fn)
  yieldChannel.port2.postMessage(null)
}

const LINK_CACHE_ROWS = 200

interface CachedRowLinks {
  readonly text: string
  readonly links: PaneLink[]
}

export class GhosttyPaneTerminal implements PaneTerminal {
  private surface: GhosttyTerminalSurface | null = null
  private disposed = false
  private readonly init: GhosttyTerminalInit
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly renderListeners = new Set<() => void>()
  private readonly selectionListeners = new Set<() => void>()
  private readonly linkProviders: PaneLinkProvider[] = []
  private readonly linkCache = new Map<number, CachedRowLinks>()
  private readonly linkQueriesInFlight = new Set<number>()
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null
  private pendingWrites: { data: string | Uint8Array; callback?: () => void }[] = []
  private burstMs = 0
  private pendingBytes = 0
  private pendingDropped = 0
  private pendingResetBeforeAttach = false
  private colsValue = 80
  private rowsValue = 24
  private readonly optionsValue: PaneTerminalOptions
  private cachedSnapshot: GhosttySnapshot | null = null
  private cachedBuffer: PaneBuffer | null = null
  private resizeListener: ((cols: number, rows: number) => void) | null = null

  constructor(init: GhosttyTerminalInit) {
    this.init = init
    this.optionsValue = this.makeOptions(init)
    void this.attach()
  }

  private makeOptions(init: GhosttyTerminalInit): PaneTerminalOptions {
    let disableStdin: boolean | undefined = init.disableStdin
    let theme: { background?: string; foreground?: string; cursor?: string } | undefined =
      init.theme
    let fontSize: number | undefined = init.fontSize
    let fontFamily: string | undefined = init.fontFamily
    let lineHeight: number | undefined = init.lineHeight
    let cursorBlink: boolean | undefined = init.cursorBlink
    const self = this
    return {
      get disableStdin() {
        return disableStdin
      },
      set disableStdin(value: boolean | undefined) {
        disableStdin = value
      },
      get theme() {
        return theme
      },
      set theme(value: { background?: string; foreground?: string; cursor?: string } | undefined) {
        theme = value
        if (value !== undefined) self.surface?.setTheme(self.init.toGhosttyTheme(value))
      },
      get fontSize() {
        return fontSize
      },
      set fontSize(value: number | undefined) {
        fontSize = value
        void self.surface?.setFont({ family: fontFamily, size: value, lineHeight })
      },
      get fontFamily() {
        return fontFamily
      },
      set fontFamily(value: string | undefined) {
        fontFamily = value
        void self.surface?.setFont({ family: value, size: fontSize, lineHeight })
      },
      get lineHeight() {
        return lineHeight
      },
      set lineHeight(value: number | undefined) {
        lineHeight = value
        void self.surface?.setFont({ family: fontFamily, size: fontSize, lineHeight: value })
      },
      get cursorBlink() {
        return cursorBlink
      },
      set cursorBlink(value: boolean | undefined) {
        cursorBlink = value
        self.surface?.setDefaultCursorBlink(value ?? true)
      }
    }
  }

  get attached(): boolean {
    return this.surface !== null
  }

  /** False when the measured box cannot hold a cell — a collapsed viewport.
   * The pane must then not report a size: the engine kept its last real grid
   * and the PTY must keep its last real size. */
  fit(): boolean {
    return this.surface?.fit() ?? false
  }

  onResize(listener: (cols: number, rows: number) => void): void {
    this.resizeListener = listener
  }

  scrollToBottom(): void {
    this.surface?.scrollToBottom()
  }

  isAtBottom(): boolean {
    return this.surface?.isAtBottom() ?? true
  }

  bufferRowCount(): number {
    return this.surface?.bufferRowCount() ?? 0
  }

  withScreenReader<T>(read: (readRow: (y: number) => string) => T): T {
    const surface = this.surface
    if (surface === null) return read(() => '')
    return surface.withScreenReader(read)
  }

  selectScreenRange(start: { x: number; y: number }, end: { x: number; y: number }): void {
    this.surface?.selectScreenRange(start, end)
  }

  revealScreenRow(y: number): void {
    this.surface?.revealScreenRow(y)
  }

  getFullText(): string {
    return this.surface?.getBufferText() ?? ''
  }

  private async attach(): Promise<void> {
    try {
      const surface = await this.init.load(this.init.host, {
        theme: this.init.toGhosttyTheme(this.optionsValue.theme ?? this.init.theme),
        font: {
          family: this.optionsValue.fontFamily ?? this.init.fontFamily,
          size: this.optionsValue.fontSize ?? this.init.fontSize,
          lineHeight: this.optionsValue.lineHeight ?? this.init.lineHeight
        },
        cursorBlink: this.optionsValue.cursorBlink ?? this.init.cursorBlink,
        maxScrollbackLines: this.init.maxScrollbackLines,
        onData: (data) => {
          if (this.optionsValue.disableStdin) return
          for (const listener of this.dataListeners) listener(data)
        },
        onResize: (cols, rows) => {
          this.colsValue = cols
          this.rowsValue = rows
          this.resizeListener?.(cols, rows)
        },
        onSelectionChange: () => {
          for (const listener of this.selectionListeners) listener()
        },
        beforeKey: (event) => this.keyHandler?.(event) ?? true,
        onLinkActivate: (text, event) => this.activateLink(text, event),
        resolveLink: (rows, rowIndex, column) => this.resolveLink(rows, rowIndex, column)
      })
      if (this.disposed) {
        surface.dispose()
        return
      }
      this.surface = surface
      this.colsValue = surface.cols
      this.rowsValue = surface.rows
      if (this.pausedState) surface.setPaused(true)
      if (this.pendingResetBeforeAttach) {
        this.pendingResetBeforeAttach = false
        surface.resetAndWrite('')
      }
      const queued = this.pendingWrites
      this.pendingWrites = []
      this.pendingBytes = 0
      for (const entry of queued) {
        surface.write(entry.data)
        entry.callback?.()
      }
      logTerminalTransport({
        source: 'terminal-transport',
        message: 'ghostty surface attached and owning the pane',
        payload: {
          session: this.init.sessionId,
          cols: surface.cols,
          rows: surface.rows,
          replayedWrites: queued.length
        }
      })
      for (const listener of this.renderListeners) listener()
      this.init.onAttached?.()
    } catch (err) {
      const queued = this.pendingWrites
      this.pendingWrites = []
      this.pendingBytes = 0
      for (const entry of queued) entry.callback?.()
      logTerminalTransport({
        source: 'terminal-transport',
        message: 'ghostty surface setup failed, this pane has no renderer',
        payload: {
          session: this.init.sessionId,
          error: String(err),
          droppedWrites: queued.length
        }
      })
    }
  }

  get cols(): number {
    return this.surface?.cols ?? this.colsValue
  }

  get rows(): number {
    return this.surface?.rows ?? this.rowsValue
  }

  get options(): PaneTerminalOptions {
    return this.optionsValue
  }

  get textarea(): HTMLTextAreaElement | undefined {
    return this.surface?.input
  }

  get modes(): {
    readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
    readonly applicationCursorKeysMode: boolean
  } {
    const tracking = this.surface?.isMouseTracking() ?? false
    return {
      mouseTrackingMode: tracking ? 'vt200' : 'none',
      applicationCursorKeysMode: this.surface?.isApplicationCursorKeys() ?? false
    }
  }

  get buffer(): { readonly active: PaneBuffer } {
    const snapshot = this.surface?.currentSnapshot() ?? null
    if (snapshot !== this.cachedSnapshot || this.cachedBuffer === null) {
      this.cachedSnapshot = snapshot
      this.cachedBuffer = this.makeBuffer(snapshot)
    }
    return { active: this.cachedBuffer }
  }

  private makeBuffer(snapshot: GhosttySnapshot | null): PaneBuffer {
    const rows = snapshot?.rowData ?? []
    const alternate = this.surface?.isAlternateScreen() ?? false
    return {
      type: alternate ? 'alternate' : 'normal',
      viewportY: 0,
      length: rows.length,
      getLine: (y: number) => {
        const row = rows[y]
        if (!row) return undefined
        return {
          isWrapped: row.isWrapContinuation,
          translateToString: (trimRight = false, startColumn = 0, endColumn?: number) => {
            const cells = row.cells.slice(startColumn, endColumn ?? row.cells.length)
            const text = cells.map((cell) => cell.text || ' ').join('')
            return trimRight ? text.trimEnd() : text
          }
        }
      }
    }
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) {
      callback?.()
      return
    }
    const surface = this.surface
    if (surface === null) {
      this.pendingWrites.push({ data, callback })
      this.pendingBytes += data.length
      if (this.pendingBytes > ATTACH_BUFFER_CAP_BYTES) this.trimPendingWrites()
      return
    }
    const startedAt = performance.now()
    surface.write(data)
    if (!callback) return
    this.burstMs += performance.now() - startedAt
    if (this.burstMs < writeBurstBudgetMs()) {
      queueMicrotask(callback)
      return
    }
    this.burstMs = 0
    yieldToEventLoop(callback)
  }

  private trimPendingWrites(): void {
    const asked = this.pendingBytes
    let dropped = 0
    while (this.pendingWrites.length > 1 && this.pendingBytes > ATTACH_BUFFER_CAP_BYTES) {
      const entry = this.pendingWrites.shift()!
      this.pendingBytes -= entry.data.length
      dropped += entry.data.length
      entry.callback?.()
    }
    const head = this.pendingWrites[0]
    if (head !== undefined && head.data instanceof Uint8Array) {
      const from = findResyncStart(head.data)
      if (from > 0) {
        this.pendingBytes -= from
        dropped += from
        this.pendingWrites[0] = { data: head.data.subarray(from), callback: head.callback }
      }
    }
    if (dropped === 0) return
    this.pendingDropped += dropped
    logTerminalTransport({
      source: 'terminal-transport',
      message: 'ghostty attach buffer overflowed, oldest output dropped',
      payload: {
        session: this.init.sessionId,
        capBytes: ATTACH_BUFFER_CAP_BYTES,
        askedBytes: asked,
        droppedBytes: dropped,
        totalDroppedBytes: this.pendingDropped,
        heldEntries: this.pendingWrites.length
      }
    })
    this.init.onAttachOverflow?.(this.pendingDropped, ATTACH_BUFFER_CAP_BYTES)
  }

  paste(data: string): void {
    this.surface?.paste(data)
  }

  clear(): void {
    if (this.surface === null) {
      this.discardPendingWrites()
      return
    }
    this.surface.write(CLEAR_SEQUENCE)
    this.linkCache.clear()
  }

  private discardPendingWrites(): void {
    for (const entry of this.pendingWrites) entry.callback?.()
    this.pendingWrites = []
    this.pendingBytes = 0
  }

  reset(): void {
    if (this.surface === null) {
      this.pendingResetBeforeAttach = true
      this.discardPendingWrites()
      return
    }
    this.surface.resetAndWrite('')
    this.linkCache.clear()
  }

  snapshotFormatVersion(): number | null {
    return this.surface?.snapshotFormatVersion() ?? null
  }

  importSnapshot(state: Uint8Array): boolean {
    if (this.surface === null) return false
    const imported = this.surface.importSnapshot(state)
    if (imported) this.linkCache.clear()
    return imported
  }

  setPaused(paused: boolean): void {
    this.pausedState = paused
    this.surface?.setPaused(paused)
  }

  private pausedState = false

  refresh(): void {
    this.surface?.repaint()
  }

  focus(): void {
    this.surface?.focus()
  }

  blur(): void {
    this.surface?.blur()
  }

  hasSelection(): boolean {
    return this.surface?.hasSelection() ?? false
  }

  getSelection(): string {
    return this.surface?.getSelection() ?? ''
  }

  clearSelection(): void {
    this.surface?.clearSelection()
  }

  onSelectionChange(listener: () => void): PaneDisposable {
    this.selectionListeners.add(listener)
    return { dispose: () => this.selectionListeners.delete(listener) }
  }

  onData(listener: (data: string) => void): PaneDisposable {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onRender(listener: () => void): PaneDisposable {
    this.renderListeners.add(listener)
    return { dispose: () => this.renderListeners.delete(listener) }
  }

  registerLinkProvider(provider: PaneLinkProvider): PaneDisposable {
    this.linkProviders.push(provider)
    return {
      dispose: () => {
        const at = this.linkProviders.indexOf(provider)
        if (at !== -1) this.linkProviders.splice(at, 1)
        this.linkCache.clear()
      }
    }
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dataListeners.clear()
    this.renderListeners.clear()
    this.selectionListeners.clear()
    this.linkProviders.length = 0
    this.linkCache.clear()
    for (const entry of this.pendingWrites) entry.callback?.()
    this.pendingWrites = []
    this.pendingBytes = 0
    this.surface?.dispose()
    this.surface = null
  }

  private resolveLink(
    rows: GhosttySnapshot['rowData'],
    rowIndex: number,
    column: number
  ): TerminalLinkWithRange | null {
    const row = rows[rowIndex]
    if (!row) return null
    const text = rowText(row)
    const cached = this.linkCache.get(rowIndex)
    if (cached === undefined || cached.text !== text) {
      this.warmRowLinks(rowIndex, text)
      return null
    }
    for (const link of cached.links) {
      const startY = link.range.start.y - 1
      const endY = link.range.end.y - 1
      if (rowIndex < startY || rowIndex > endY) continue
      const startX = rowIndex === startY ? link.range.start.x - 1 : 0
      const endX = rowIndex === endY ? link.range.end.x - 1 : row.cells.length - 1
      if (column < startX || column > endX) continue
      return {
        text: link.text,
        range: { start: { x: startX, y: startY }, end: { x: endX, y: endY } }
      }
    }
    return null
  }

  private warmRowLinks(rowIndex: number, text: string): void {
    if (this.linkProviders.length === 0 || this.linkQueriesInFlight.has(rowIndex)) return
    this.linkQueriesInFlight.add(rowIndex)
    const collected: PaneLink[] = []
    let outstanding = this.linkProviders.length
    const settle = (): void => {
      outstanding -= 1
      if (outstanding > 0) return
      this.linkQueriesInFlight.delete(rowIndex)
      if (this.disposed) return
      if (this.linkCache.size >= LINK_CACHE_ROWS) {
        const oldest = this.linkCache.keys().next()
        if (!oldest.done) this.linkCache.delete(oldest.value)
      }
      this.linkCache.set(rowIndex, { text, links: collected })
      if (collected.length > 0) this.surface?.refreshHover()
    }
    for (const provider of this.linkProviders) {
      let answered = false
      provider.provideLinks(rowIndex + 1, (links) => {
        if (answered) return
        answered = true
        if (links) collected.push(...links)
        settle()
      })
    }
  }

  private activateLink(text: string, event: MouseEvent): void {
    for (const cached of this.linkCache.values()) {
      for (const link of cached.links) {
        if (link.text === text) {
          link.activate(event, text)
          return
        }
      }
    }
    this.urlActivate?.(text, event)
  }

  urlActivate: ((text: string, event: MouseEvent) => void) | null = null
}

function hexToRgb(hex: string | undefined): { r: number; g: number; b: number } {
  const m = hex ? /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim()) : null
  if (!m) return { r: 255, g: 255, b: 255 }
  const raw = m[1]
  const h = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  }
}

export function ghosttyThemeFromCss(theme: {
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
}): GhosttyTheme {
  return {
    background: hexToRgb(theme.background),
    foreground: hexToRgb(theme.foreground),
    cursor: hexToRgb(theme.cursor),
    ...(theme.selectionBackground !== undefined
      ? { selectionBackground: theme.selectionBackground }
      : {})
  }
}

function rowText(row: GhosttySnapshot['rowData'][number]): string {
  return row.cells
    .map((cell) => cell.text || ' ')
    .join('')
    .trimEnd()
}
