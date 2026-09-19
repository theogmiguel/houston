import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttySnapshot,
} from "./core";
import { drawCustomGlyph, isCustomGlyph } from "./customGlyphs";

export interface GhosttyCellMetrics {
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

export interface GhosttyCellRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

const DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)";

const cssColorCache = new Map<number, string>();

export function cssColor(color: GhosttyColor): string {
  const key = (color.r << 16) | (color.g << 8) | color.b;
  const hit = cssColorCache.get(key);
  if (hit !== undefined) return hit;
  const value = `rgb(${color.r}, ${color.g}, ${color.b})`;
  cssColorCache.set(key, value);
  return value;
}

export function syncCanvasBackground(
  canvas: Pick<HTMLCanvasElement, "style">,
  previous: GhosttyColor | null,
  background: GhosttyColor,
): GhosttyColor {
  if (previous !== null && ghosttyColorsEqual(previous, background)) return previous;
  canvas.style.backgroundColor = groundColor(background);
  return background;
}

function groundColor(color: GhosttyColor): string {
  return `rgb(${color.r} ${color.g} ${color.b} / var(--terminal-coat, 1))`;
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  );
}

export function ghosttyTextRunEnd(
  cells: readonly GhosttyCell[],
  start: number,
  sameStyle: (cell: GhosttyCell) => boolean,
): number {
  let end = start + 1;
  while (end < cells.length) {
    const next = cells[end];
    if (!next) break;
    if (next.wide === GHOSTTY_CELL_WIDE.spacerTail) {
      end += 1;
      continue;
    }
    if (next.text.length === 0 || !sameStyle(next)) break;
    end += 1;
  }
  return end;
}

let fontCacheKey = "";
const fontCache = new Map<number, string>();

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const key = `${fontSize}px ${fontFamily}`;
  if (key !== fontCacheKey) {
    fontCacheKey = key;
    fontCache.clear();
  }
  const variant = (cell.italic ? 1 : 0) | (cell.bold ? 2 : 0);
  const hit = fontCache.get(variant);
  if (hit !== undefined) return hit;
  const style = cell.italic ? "italic" : "normal";
  const weight = cell.bold ? "700" : "400";
  const value = `${style} ${weight} ${key}`;
  fontCache.set(variant, value);
  return value;
}

export function snapToDevice(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.35;

export function measureGhosttyCell(
  context: CanvasRenderingContext2D,
  fontSize: number,
  fontFamily: string,
  devicePixelRatio = 1,
  lineHeight = DEFAULT_TERMINAL_LINE_HEIGHT,
): GhosttyCellMetrics {
  context.font = `normal 400 ${fontSize}px ${fontFamily}`;
  const widthMeasurement = context.measureText("M");
  const verticalMeasurement = context.measureText("Mg");
  const ascent = verticalMeasurement.actualBoundingBoxAscent || fontSize;
  const descent = verticalMeasurement.actualBoundingBoxDescent;
  const glyphHeight = ascent + descent;
  const height = Math.max(1, Math.round(fontSize * lineHeight), Math.ceil(glyphHeight));
  const minimum = 1 / devicePixelRatio;
  return {
    width: Math.max(minimum, snapToDevice(Math.max(1, widthMeasurement.width), devicePixelRatio)),
    height: Math.max(minimum, snapToDevice(height, devicePixelRatio)),
    baseline: snapToDevice(Math.round((height - glyphHeight) / 2 + ascent), devicePixelRatio),
  };
}

export function terminalGridSize(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((width - padding * 2) / metrics.width)),
    rows: Math.max(1, Math.floor((height - padding * 2) / metrics.height)),
  };
}

/** A box under one cell is a collapsed viewport, not a terminal one column
 * wide: a minimized window's client area measures a few pixels, and resizing
 * the PTY to it makes the CLI redraw its whole screen twice. */
export function boxFitsOneCell(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): boolean {
  return width - padding * 2 >= metrics.width && height - padding * 2 >= metrics.height;
}

export function renderGhosttySnapshot(options: {
  readonly context: CanvasRenderingContext2D;
  readonly snapshot: GhosttySnapshot;
  readonly metrics: GhosttyCellMetrics;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly padding: number;
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused?: boolean;
  readonly selectionBackground?: string;
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  readonly originY?: number;
  readonly devicePixelRatio?: number;
}): void {
  const {
    context,
    snapshot,
    metrics,
    fontSize,
    fontFamily,
    padding,
    forceFull,
    cursorOn,
    previousCursorY,
  } = options;
  const focused = options.focused ?? true;
  const selectionBackground = options.selectionBackground ?? DEFAULT_SELECTION_BACKGROUND;
  const hoveredLinkRange = options.hoveredLinkRange ?? null;
  const originY = options.originY ?? padding;
  const devicePixelRatio = options.devicePixelRatio ?? 1;
  const rowsToDraw = forceFull
    ? Array.from({ length: snapshot.rows }, (_, index) => index)
    : [...snapshot.dirtyRows];
  if (
    previousCursorY !== null &&
    previousCursorY !== undefined &&
    previousCursorY >= 0 &&
    !rowsToDraw.includes(previousCursorY)
  ) {
    rowsToDraw.push(previousCursorY);
  }
  if (snapshot.cursorVisible && snapshot.cursorY >= 0 && !rowsToDraw.includes(snapshot.cursorY)) {
    rowsToDraw.push(snapshot.cursorY);
  }

  if (forceFull) {
    context.save();
    context.resetTransform();
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  context.textBaseline = "alphabetic";
  const clipBleed = metrics.width / 2;
  const verticalClipBleed = metrics.height / 4;

  const bands: { start: number; end: number }[] = [];
  for (const rowIndex of [...new Set(rowsToDraw)].sort((left, right) => left - right)) {
    const last = bands[bands.length - 1];
    if (last && rowIndex <= last.end + 2) last.end = rowIndex;
    else bands.push({ start: rowIndex, end: rowIndex });
  }
  const repaintWidth = Math.max(
    context.canvas.width,
    padding * 2 + snapshot.cols * metrics.width + metrics.width,
  );

  for (const band of bands) {
    const bandTop = Math.max(0, originY + band.start * metrics.height - verticalClipBleed);
    const bandBottom = originY + (band.end + 1) * metrics.height + verticalClipBleed;
    context.save();
    context.beginPath();
    context.rect(0, bandTop, repaintWidth, bandBottom - bandTop);
    context.clip();

    for (let rowIndex = band.start - 1; rowIndex <= band.end + 1; rowIndex += 1) {
      const row = snapshot.rowData[rowIndex];
      if (!row) continue;
      const top = originY + rowIndex * metrics.height;

      context.clearRect(0, top, repaintWidth, metrics.height);

      let backgroundStart = 0;
      while (backgroundStart < row.cells.length) {
        const first = row.cells[backgroundStart];
        if (!first) break;
        let backgroundEnd = backgroundStart + 1;
        while (backgroundEnd < row.cells.length) {
          const next = row.cells[backgroundEnd];
          if (
            !next ||
            next.selected !== first.selected ||
            !ghosttyColorsEqual(next.background, first.background)
          ) {
            break;
          }
          backgroundEnd += 1;
        }
        if (first.selected || !ghosttyColorsEqual(first.background, snapshot.background)) {
          const left = padding + backgroundStart * metrics.width;
          const width = (backgroundEnd - backgroundStart) * metrics.width;
          if (!ghosttyColorsEqual(first.background, snapshot.background)) {
            context.fillStyle = cssColor(first.background);
            context.fillRect(left, top, width, metrics.height);
          }
          if (first.selected) {
            context.fillStyle = selectionBackground;
            context.fillRect(left, top, width, metrics.height);
          }
        }
        backgroundStart = backgroundEnd;
      }
    }

    for (let rowIndex = band.start - 1; rowIndex <= band.end + 1; rowIndex += 1) {
      const row = snapshot.rowData[rowIndex];
      if (!row) continue;
      const top = originY + rowIndex * metrics.height;

      let runStart = 0;
      while (runStart < row.cells.length) {
        const first = row.cells[runStart];
        if (!first) break;
        if (first.text.length === 0) {
          runStart += 1;
          continue;
        }
        if (isCustomGlyph(first.text)) {
          if (!first.invisible) {
            context.fillStyle = cssColor(first.foreground);
            drawCustomGlyph(
              context,
              first.text,
              padding + runStart * metrics.width,
              top,
              metrics.width,
              metrics.height,
            );
          }
          runStart += 1;
          continue;
        }
        const runEnd = ghosttyTextRunEnd(
          row.cells,
          runStart,
          (cell) => sameTextStyle(cell, first) && !isCustomGlyph(cell.text),
        );
        const text = row.cells
          .slice(runStart, runEnd)
          .map((cell) => cell.text)
          .join("");
        if (!first.invisible && text.trim().length > 0) {
          context.save();
          context.beginPath();
          context.rect(
            padding + runStart * metrics.width - clipBleed,
            top - verticalClipBleed,
            (runEnd - runStart) * metrics.width + clipBleed * 2,
            metrics.height + verticalClipBleed * 2,
          );
          context.clip();
          context.font = fontForCell(first, fontSize, fontFamily);
          context.fillStyle = cssColor(first.foreground);
          context.fillText(
            text,
            padding + runStart * metrics.width,
            top + metrics.baseline,
            (runEnd - runStart) * metrics.width,
          );
          context.restore();
        }
        runStart = runEnd;
      }

      const linkTouchesRow =
        hoveredLinkRange !== null &&
        rowIndex >= hoveredLinkRange.start.y &&
        rowIndex <= hoveredLinkRange.end.y;
      let rowHasDecoration = linkTouchesRow;
      if (!rowHasDecoration) {
        for (const cell of row.cells) {
          if (cell.underline || cell.strikethrough || cell.overline) {
            rowHasDecoration = true;
            break;
          }
        }
      }
      for (let column = 0; rowHasDecoration && column < row.cells.length; column += 1) {
        const cell = row.cells[column];
        const hoveredLink =
          linkTouchesRow &&
          hoveredLinkRange !== null &&
          (rowIndex > hoveredLinkRange.start.y || column >= hoveredLinkRange.start.x) &&
          (rowIndex < hoveredLinkRange.end.y || column <= hoveredLinkRange.end.x);
        if (!cell || (!cell.underline && !cell.strikethrough && !cell.overline && !hoveredLink)) {
          continue;
        }
        context.fillStyle = cssColor(cell.foreground);
        const left = padding + column * metrics.width;
        const hairline = 1 / devicePixelRatio;
        if (cell.underline || hoveredLink) {
          context.fillRect(
            left,
            snapToDevice(top + metrics.height - 2, devicePixelRatio),
            metrics.width,
            hairline,
          );
        }
        if (cell.strikethrough) {
          context.fillRect(
            left,
            snapToDevice(top + Math.floor(metrics.height * 0.55), devicePixelRatio),
            metrics.width,
            hairline,
          );
        }
        if (cell.overline) {
          context.fillRect(left, snapToDevice(top + 1, devicePixelRatio), metrics.width, hairline);
        }
      }
    }
    context.restore();
  }

  if (cursorOn && snapshot.cursorVisible && snapshot.cursorX >= 0 && snapshot.cursorY >= 0) {
    const left = padding + snapshot.cursorX * metrics.width;
    const top = originY + snapshot.cursorY * metrics.height;
    context.fillStyle = cssColor(snapshot.cursor);
    const strokeInset = 0.5 / devicePixelRatio;
    const caret = Math.max(1, Math.round(2 * devicePixelRatio)) / devicePixelRatio;
    if (!focused) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.lineWidth = 1 / devicePixelRatio;
      context.strokeRect(
        left + strokeInset,
        top + strokeInset,
        metrics.width - strokeInset * 2,
        metrics.height - strokeInset * 2,
      );
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, caret, metrics.height);
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + metrics.height - caret, metrics.width, caret);
    } else if (snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.lineWidth = 1 / devicePixelRatio;
      context.strokeRect(
        left + strokeInset,
        top + strokeInset,
        metrics.width - strokeInset * 2,
        metrics.height - strokeInset * 2,
      );
    } else {
      context.fillRect(left, top, metrics.width, metrics.height);
      const cell = snapshot.rowData[snapshot.cursorY]?.cells[snapshot.cursorX];
      if (cell?.text) {
        context.font = fontForCell(cell, fontSize, fontFamily);
        context.fillStyle = cssColor(snapshot.background);
        context.fillText(cell.text, left, top + metrics.baseline, metrics.width);
      }
    }
  }
}
