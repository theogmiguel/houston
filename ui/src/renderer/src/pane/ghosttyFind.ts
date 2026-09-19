export interface PaneFinder {
  findNext(needle: string, options?: { incremental?: boolean }): boolean
  findPrevious(needle: string): boolean
  clearDecorations(): void
}

export interface FindableSurface {
  readonly cols: number
  bufferRowCount(): number
  withScreenReader<T>(read: (readRow: (y: number) => string) => T): T
  selectScreenRange(start: { x: number; y: number }, end: { x: number; y: number }): void
  revealScreenRow(y: number): void
  clearSelection(): void
}

export interface FindMatch {
  readonly row: number
  readonly startColumn: number
  readonly endColumn: number
}

// Rows scanned per direction before a search gives up. Each row costs two
// WASM calls, and incremental search runs on every keystroke -- this cap is
// above today's scrollback size on purpose, so it never trips yet.
export const FIND_SCAN_ROW_CAP = 12_000

function indexOfMatch(haystack: string, needle: string, from: number): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from)
}

export function findForward(
  readRow: (y: number) => string,
  rowCount: number,
  needle: string,
  fromRow: number,
  fromColumn: number
): FindMatch | null {
  if (needle.length === 0 || rowCount <= 0) return null
  const scanned = Math.min(rowCount, FIND_SCAN_ROW_CAP)
  for (let step = 0; step <= scanned; step += 1) {
    const row = (((fromRow + step) % rowCount) + rowCount) % rowCount
    const start = step === 0 ? fromColumn : 0
    const at = indexOfMatch(readRow(row), needle, start)
    if (at !== -1) return { row, startColumn: at, endColumn: at + needle.length - 1 }
  }
  return null
}

export function findBackward(
  readRow: (y: number) => string,
  rowCount: number,
  needle: string,
  fromRow: number,
  fromColumn: number
): FindMatch | null {
  if (needle.length === 0 || rowCount <= 0) return null
  const scanned = Math.min(rowCount, FIND_SCAN_ROW_CAP)
  for (let step = 0; step <= scanned; step += 1) {
    const row = (((fromRow - step) % rowCount) + rowCount) % rowCount
    const text = readRow(row)
    const limit = step === 0 ? fromColumn : text.length
    const at = text.toLowerCase().lastIndexOf(needle.toLowerCase(), Math.max(0, limit))
    if (at !== -1 && at <= limit) {
      return { row, startColumn: at, endColumn: at + needle.length - 1 }
    }
  }
  return null
}

export function createGhosttyFinder(surface: FindableSurface): PaneFinder {
  let cursor: FindMatch | null = null
  let lastNeedle = ''

  const run = (needle: string, backward: boolean, incremental: boolean): boolean => {
    if (needle.length === 0) {
      cursor = null
      lastNeedle = ''
      surface.clearSelection()
      return false
    }
    const rowCount = Math.max(0, surface.bufferRowCount())
    if (rowCount === 0) return false
    const restart = needle.toLowerCase() !== lastNeedle.toLowerCase()
    const anchor = restart || cursor === null ? null : cursor
    const match = surface.withScreenReader((readRow) => {
      if (backward) {
        const fromRow = anchor === null ? rowCount - 1 : anchor.row
        const fromColumn = anchor === null ? Number.MAX_SAFE_INTEGER : anchor.startColumn - 1
        return findBackward(readRow, rowCount, needle, fromRow, Math.max(-1, fromColumn))
      }
      const fromRow = anchor === null ? 0 : anchor.row
      const fromColumn =
        anchor === null ? 0 : incremental ? anchor.startColumn : anchor.startColumn + 1
      return findForward(readRow, rowCount, needle, fromRow, fromColumn)
    })
    lastNeedle = needle
    if (match === null) {
      cursor = null
      return false
    }
    cursor = match
    surface.revealScreenRow(match.row)
    surface.selectScreenRange(
      { x: match.startColumn, y: match.row },
      { x: Math.min(match.endColumn, Math.max(0, surface.cols - 1)), y: match.row }
    )
    return true
  }

  return {
    findNext: (needle, options) => run(needle, false, options?.incremental === true),
    findPrevious: (needle) => run(needle, true, false),
    clearDecorations: () => {
      cursor = null
      lastNeedle = ''
    }
  }
}
