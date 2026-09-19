import { vi, type Mock } from 'vitest'
import type { GhosttyCell, GhosttyColor, GhosttyRow, GhosttySnapshot } from '../ghostty/core'

const BLACK: GhosttyColor = { r: 0, g: 0, b: 0 }

function cell(text: string): GhosttyCell {
  return {
    text,
    wide: 0,
    foreground: BLACK,
    background: BLACK,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false
  }
}

function row(text: string, isWrapContinuation = false): GhosttyRow {
  return {
    cells: [...text].map(cell),
    text,
    isWrapContinuation,
    wrapsToNext: false
  }
}

export interface GhosttySurfaceMock {
  cols: number
  rowCount: number
  gridRows: string[] | null
  wrappedRows: Set<number>
  selection: string
  alternateScreen: boolean
  mouseTracking: boolean
  applicationCursorKeys: boolean
  createShouldThrow: boolean
  gate: (() => void) | null
  /** What a real `fit()` answers for a box that cannot hold a cell: false,
   * no resize notification. Tests use it to stand in for a collapsed pane. */
  fitOk: boolean

  readonly writeSpy: Mock<(data: string | Uint8Array) => void>
  readonly setPausedSpy: Mock<(paused: boolean) => void>
  readonly resetSpy: Mock<() => void>
  readonly importSnapshotSpy: Mock<(state: Uint8Array) => void>
  importSnapshotSucceeds: boolean
  snapshotFormatVersion: number
  readonly pasteSpy: Mock<(data: string) => void>
  readonly fitSpy: Mock<() => void>
  readonly focusSpy: Mock<() => void>
  readonly blurSpy: Mock<() => void>
  readonly themeSpy: Mock<(theme: unknown) => void>
  readonly fontSpy: Mock<(family: string, size: number, lineHeight?: number) => void>
  readonly cursorBlinkSpy: Mock<(enabled: boolean) => void>
  readonly scrollSpy: Mock<(delta: number) => void>
  readonly forceRenderSpy: Mock<() => void>
  readonly disposeSpy: Mock<() => void>
  createCount: number
  writes: (string | Uint8Array)[]
  input: HTMLTextAreaElement
  canvas: HTMLCanvasElement
  createOptions: Record<string, unknown> | null

  emitData: (data: string) => void
  emitResize: (cols: number, rows: number) => void
  emitSelectionChange: () => void
  emitKey: (event: KeyboardEvent) => boolean
  emitResolveLink: (rowIndex: number, column: number) => { text: string } | null
  emitLinkActivate: (text: string) => void

  reset(): void
}

const spies = {
  writeSpy: vi.fn<(data: string | Uint8Array) => void>(),
  resetSpy: vi.fn<() => void>(),
  importSnapshotSpy: vi.fn<(state: Uint8Array) => void>(),
  pasteSpy: vi.fn<(data: string) => void>(),
  fitSpy: vi.fn<() => void>(),
  focusSpy: vi.fn<() => void>(),
  blurSpy: vi.fn<() => void>(),
  themeSpy: vi.fn<(theme: unknown) => void>(),
  fontSpy: vi.fn<(family: string, size: number, lineHeight?: number) => void>(),
  cursorBlinkSpy: vi.fn<(enabled: boolean) => void>(),
  scrollSpy: vi.fn<(delta: number) => void>(),
  forceRenderSpy: vi.fn<() => void>(),
  setPausedSpy: vi.fn<(paused: boolean) => void>(),
  disposeSpy: vi.fn<() => void>()
}

function makeState(): GhosttySurfaceMock {
  const input = document.createElement('textarea')
  const canvas = document.createElement('canvas')
  canvas.dataset.testid = 'ghostty-canvas'
  return {
    cols: 80,
    rowCount: 24,
    gridRows: null,
    wrappedRows: new Set<number>(),
    selection: '',
    alternateScreen: false,
    mouseTracking: false,
    applicationCursorKeys: false,
    createShouldThrow: false,
    gate: null,
    fitOk: true,
    createCount: 0,
    writes: [],
    writeSpy: spies.writeSpy,
    setPausedSpy: spies.setPausedSpy,
    resetSpy: spies.resetSpy,
    importSnapshotSpy: spies.importSnapshotSpy,
    importSnapshotSucceeds: true,
    snapshotFormatVersion: 1,
    pasteSpy: spies.pasteSpy,
    fitSpy: spies.fitSpy,
    focusSpy: spies.focusSpy,
    blurSpy: spies.blurSpy,
    themeSpy: spies.themeSpy,
    fontSpy: spies.fontSpy,
    cursorBlinkSpy: spies.cursorBlinkSpy,
    scrollSpy: spies.scrollSpy,
    forceRenderSpy: spies.forceRenderSpy,
    disposeSpy: spies.disposeSpy,
    input,
    canvas,
    createOptions: null,
    emitData: () => {},
    emitResize: () => {},
    emitSelectionChange: () => {},
    emitKey: () => true,
    emitResolveLink: () => null,
    emitLinkActivate: () => {},
    reset() {
      for (const spy of Object.values(spies)) spy.mockClear()
      Object.assign(this, makeState())
    }
  }
}

export const ghosttyMock: GhosttySurfaceMock = makeState()

function snapshot(): GhosttySnapshot | null {
  const rows = ghosttyMock.gridRows
  if (rows === null) return null
  return {
    cols: ghosttyMock.cols,
    rows: ghosttyMock.rowCount,
    foreground: BLACK,
    background: BLACK,
    cursor: BLACK,
    cursorX: 0,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle: 0,
    scrollback: 0,
    rowData: rows.map((text, i) => row(text, ghosttyMock.wrappedRows.has(i)))
  } as unknown as GhosttySnapshot
}

export function ghosttySurfaceMockModule(): {
  GhosttyTerminalSurface: {
    create: (host: HTMLElement, options: Record<string, unknown>) => Promise<unknown>
  }
} {
  return {
    GhosttyTerminalSurface: {
      create: async (host: HTMLElement, options: Record<string, unknown>) => {
        ghosttyMock.createCount += 1
        if (ghosttyMock.gate !== null) {
          const held = ghosttyMock.gate
          await new Promise<void>((resolve) => {
            ghosttyMock.gate = () => {
              held()
              resolve()
            }
          })
        }
        if (ghosttyMock.createShouldThrow) throw new Error('surface create failed (test)')
        ghosttyMock.createOptions = options

        const opts = options as {
          onData?: (data: string) => void
          onResize?: (cols: number, rows: number) => void
          onSelectionChange?: () => void
          beforeKey?: (event: KeyboardEvent) => boolean
          resolveLink?: (
            rows: GhosttySnapshot['rowData'],
            rowIndex: number,
            column: number
          ) => { text: string } | null
          onLinkActivate?: (text: string, event: MouseEvent) => void
        }
        let lastReported: { cols: number; rows: number } | null = null
        ghosttyMock.emitData = (data) => opts.onData?.(data)
        ghosttyMock.emitResize = (c, r) => opts.onResize?.(c, r)
        ghosttyMock.emitSelectionChange = () => opts.onSelectionChange?.()
        ghosttyMock.emitKey = (event) => opts.beforeKey?.(event) ?? true
        ghosttyMock.emitResolveLink = (rowIndex, column) =>
          opts.resolveLink?.(snapshot()?.rowData ?? [], rowIndex, column) ?? null
        ghosttyMock.emitLinkActivate = (text) =>
          opts.onLinkActivate?.(text, new MouseEvent('click', { bubbles: true }))
        host.replaceChildren(ghosttyMock.canvas, ghosttyMock.input)
        // The real surface fits itself at the end of `create()`, and that
        // first fit always notifies -- it is how the pane learns the settled
        // size. A collapsed box (fitOk=false) notifies nothing, as `fit()`.
        if (ghosttyMock.fitOk) {
          lastReported = { cols: ghosttyMock.cols, rows: ghosttyMock.rowCount }
          opts.onResize?.(ghosttyMock.cols, ghosttyMock.rowCount)
        }

        return {
          get cols() {
            return ghosttyMock.cols
          },
          get rows() {
            return ghosttyMock.rowCount
          },
          input: ghosttyMock.input,
          write: (data: string | Uint8Array) => {
            ghosttyMock.writes.push(data)
            ghosttyMock.writeSpy(data)
          },
          resetAndWrite: () => {
            ghosttyMock.resetSpy()
          },
          snapshotFormatVersion: () => ghosttyMock.snapshotFormatVersion,
          importSnapshot: (state: Uint8Array) => {
            ghosttyMock.importSnapshotSpy(state)
            return ghosttyMock.importSnapshotSucceeds
          },
          paste: (data: string) => {
            ghosttyMock.pasteSpy(data)
          },
          setTheme: (theme: unknown) => {
            ghosttyMock.themeSpy(theme)
          },
          setFont: async (font: { family?: string; size?: number; lineHeight?: number }) => {
            ghosttyMock.fontSpy(font.family ?? '', font.size ?? 0, font.lineHeight)
          },
          setDefaultCursorBlink: (enabled: boolean) => {
            ghosttyMock.cursorBlinkSpy(enabled)
          },
          focus: () => {
            ghosttyMock.focusSpy()
          },
          blur: () => {
            ghosttyMock.blurSpy()
          },
          fit: () => {
            ghosttyMock.fitSpy()
            if (!ghosttyMock.fitOk) return false
            if (
              lastReported !== null &&
              lastReported.cols === ghosttyMock.cols &&
              lastReported.rows === ghosttyMock.rowCount
            )
              return true
            lastReported = { cols: ghosttyMock.cols, rows: ghosttyMock.rowCount }
            opts.onResize?.(ghosttyMock.cols, ghosttyMock.rowCount)
            return true
          },
          scroll: (delta: number) => {
            ghosttyMock.scrollSpy(delta)
          },
          hasSelection: () => ghosttyMock.selection.length > 0,
          getSelection: () => ghosttyMock.selection,
          clearSelection: () => {
            ghosttyMock.selection = ''
          },
          selectAll: () => {},
          getBufferText: () => (ghosttyMock.gridRows ?? []).join('\n'),
          scrollToBottom: () => {},
          isAtBottom: () => true,
          bufferRowCount: () => (ghosttyMock.gridRows ?? []).length,
          withScreenReader: (read: (readRow: (y: number) => string) => unknown) =>
            read((y) => ghosttyMock.gridRows?.[y] ?? ''),
          selectScreenRange: () => {},
          revealScreenRow: () => {},
          currentSnapshot: snapshot,
          isAlternateScreen: () => ghosttyMock.alternateScreen,
          isMouseTracking: () => ghosttyMock.mouseTracking,
          isApplicationCursorKeys: () => ghosttyMock.applicationCursorKeys,
          refreshHover: () => {},
          repaint: () => {
            ghosttyMock.forceRenderSpy()
          },
          setPaused: (paused: boolean) => {
            ghosttyMock.setPausedSpy(paused)
          },
          scrollbarState: () => null,
          dispose: () => {
            ghosttyMock.disposeSpy()
          }
        }
      }
    }
  }
}

export async function flushGhosttyAttach(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve()
}
