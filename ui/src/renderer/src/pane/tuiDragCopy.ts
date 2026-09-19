import { stripBoxGlyphs } from './copyOutput'

export interface CellPos {
  col: number
  row: number
}

export interface CellRect {
  left: number
  top: number
  width: number
  height: number
}

export function pixelToCell(cols: number, rows: number, rect: CellRect, x: number, y: number): CellPos {
  const cellWidth = rect.width / Math.max(cols, 1) || 1
  const cellHeight = rect.height / Math.max(rows, 1) || 1
  const col = Math.floor((x - rect.left) / cellWidth)
  const row = Math.floor((y - rect.top) / cellHeight)
  return {
    col: Math.min(Math.max(col, 0), Math.max(cols - 1, 0)),
    row: Math.min(Math.max(row, 0), Math.max(rows - 1, 0))
  }
}

export interface DragBufferLineLike {
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface DragBufferLike {
  getLine(y: number): DragBufferLineLike | undefined
}

export function extractDragRangeText(
  buf: DragBufferLike,
  start: CellPos,
  end: CellPos,
  stripBox: boolean
): string {
  let a = start
  let b = end
  if (a.row > b.row || (a.row === b.row && a.col > b.col)) {
    ;[a, b] = [b, a]
  }
  const lines: string[] = []
  for (let row = a.row; row <= b.row; row++) {
    const line = buf.getLine(row)
    if (!line) continue
    const startCol = row === a.row ? a.col : 0
    const endCol = row === b.row ? b.col + 1 : undefined
    lines.push(line.translateToString(true, startCol, endCol))
  }
  const joined = lines.join('\n')
  return stripBox ? stripBoxGlyphs(joined) : joined
}

export const TUI_DRAG_EMPTY_HINT = 'No selection — hold Shift and drag'
