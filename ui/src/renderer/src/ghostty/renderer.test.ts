// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  boxFitsOneCell,
  cssColor,
  ghosttyTextRunEnd,
  measureGhosttyCell,
  renderGhosttySnapshot,
  snapToDevice,
  syncCanvasBackground,
  terminalGridSize,
  type GhosttyCellMetrics,
  type GhosttyCellRange,
} from "./renderer";
import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttyColor, type GhosttyRow, type GhosttySnapshot } from "./core";

function color(r: number, g: number, b: number): GhosttyColor {
  return { r, g, b };
}

function cell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    text: "",
    wide: GHOSTTY_CELL_WIDE.narrow,
    foreground: color(230, 230, 230),
    background: color(10, 10, 10),
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false,
    ...overrides,
  };
}

function row(cells: readonly GhosttyCell[]): GhosttyRow {
  return { cells, text: null, isWrapContinuation: false, wrapsToNext: false };
}

function metrics(overrides: Partial<GhosttyCellMetrics> = {}): GhosttyCellMetrics {
  return { width: 9, height: 18, baseline: 14, ...overrides };
}

function snapshot(overrides: Partial<GhosttySnapshot> & { rowData: readonly GhosttyRow[] }): GhosttySnapshot {
  return {
    cols: overrides.rowData[0]?.cells.length ?? 1,
    rows: overrides.rowData.length,
    foreground: color(230, 230, 230),
    background: color(10, 10, 10),
    cursor: color(255, 255, 0),
    cursorX: -1,
    cursorY: -1,
    cursorVisible: false,
    cursorBlinking: false,
    cursorStyle: 0,
    dirtyRows: new Set(),
    ...overrides,
  };
}

type RecordedCall = { op: string; args: readonly unknown[]; style?: string; font?: string };

function recordingContext(canvasWidth = 400, canvasHeight = 300) {
  const calls: RecordedCall[] = [];
  let fillStyle = "";
  let strokeStyle = "";
  let font = "";
  const context = {
    canvas: { width: canvasWidth, height: canvasHeight },
    textBaseline: "",
    lineWidth: 1,
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(value: string) {
      strokeStyle = value;
    },
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    resetTransform: () => calls.push({ op: "resetTransform", args: [] }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    clip: () => calls.push({ op: "clip", args: [] }),
    rect: (...args: number[]) => calls.push({ op: "rect", args }),
    clearRect: (...args: number[]) => calls.push({ op: "clearRect", args }),
    fillRect: (...args: number[]) => calls.push({ op: "fillRect", args, style: fillStyle }),
    strokeRect: (...args: number[]) => calls.push({ op: "strokeRect", args, style: strokeStyle }),
    fillText: (...args: unknown[]) => calls.push({ op: "fillText", args, style: fillStyle, font }),
    measureText: (text: string) => ({
      width: text.length * 6,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
    }),
  };
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

function fillRects(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((entry) => entry.op === "fillRect");
}

describe("terminalGridSize", () => {
  it("divides the padded pixel area by the cell metrics", () => {
    const size = terminalGridSize(822, 422, metrics({ width: 9, height: 18 }), 6);
    expect(size).toEqual({ cols: 90, rows: 22 });
  });

  it("never yields a zero-sized grid when the pixel area is smaller than one padded cell", () => {
    const size = terminalGridSize(5, 5, metrics({ width: 9, height: 18 }), 6);
    expect(size).toEqual({ cols: 1, rows: 1 });
  });
});

describe("boxFitsOneCell", () => {
  const metrics = { width: 10, height: 20, baseline: 15 };

  it("refuses a collapsed viewport's few-pixel box", () => {
    expect(boxFitsOneCell(8, 12, metrics, 4)).toBe(false);
    expect(boxFitsOneCell(0, 0, metrics, 4)).toBe(false);
  });

  it("accepts a box with room for exactly one cell plus padding", () => {
    expect(boxFitsOneCell(18, 28, metrics, 4)).toBe(true);
  });
});

describe("measureGhosttyCell", () => {
  function measuringContext(ascent: number, descent: number, cellWidth = 8) {
    let font = "";
    return {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      measureText: (text: string) =>
        text === "M"
          ? { width: cellWidth, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }
          : { width: 0, actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent },
    } as unknown as CanvasRenderingContext2D;
  }

  it("takes the descender-aware glyph box when it exceeds the line-height row", () => {
    const context = measuringContext(10, 8);
    const result = measureGhosttyCell(context, 10, "monospace");
    expect(result.height).toBe(18);
    expect(result.baseline).toBe(10);
  });

  it("uses the DEFAULT_TERMINAL_LINE_HEIGHT multiplier when the glyph box is smaller", () => {
    const context = measuringContext(8, 2);
    const result = measureGhosttyCell(context, 10, "monospace");
    expect(result.height).toBe(14);
  });

  it("honours an explicit line-height multiplier", () => {
    const context = measuringContext(8, 2);
    const result = measureGhosttyCell(context, 10, "monospace", 1, 1.0);
    expect(result.height).toBe(10);
  });

  it("floors width and height at one device pixel for a vanishing font", () => {
    const context = measuringContext(0, 0, 0);
    const result = measureGhosttyCell(context, 1, "monospace", 2);
    expect(result.width).toBeGreaterThanOrEqual(0.5);
    expect(result.height).toBeGreaterThanOrEqual(0.5);
  });

  it("snaps width to the device-pixel grid at a fractional DPR", () => {
    const context = measuringContext(8, 2, 10.2);
    const result = measureGhosttyCell(context, 10, "monospace", 1.5);
    expect(result.width).toBe(snapToDevice(10.2, 1.5));
  });
});

describe("ghosttyTextRunEnd", () => {
  it("extends through a wide cell's spacer tail regardless of its own style", () => {
    const cells = [
      cell({ text: "A" }),
      cell({ text: "永", wide: GHOSTTY_CELL_WIDE.wide }),
      cell({ text: "", wide: GHOSTTY_CELL_WIDE.spacerTail, bold: true }),
      cell({ text: "B", bold: true }),
    ];
    const end = ghosttyTextRunEnd(cells, 0, (candidate) => !candidate.bold);
    expect(end).toBe(3);
  });

  it("stops at the first cell whose style no longer matches", () => {
    const cells = [cell({ text: "A" }), cell({ text: "B" }), cell({ text: "C", italic: true })];
    const end = ghosttyTextRunEnd(cells, 0, (candidate) => !candidate.italic);
    expect(end).toBe(2);
  });

  it("stops at a blank cell", () => {
    const cells = [cell({ text: "A" }), cell({ text: "" }), cell({ text: "B" })];
    const end = ghosttyTextRunEnd(cells, 0, () => true);
    expect(end).toBe(1);
  });
});

describe("cssColor", () => {
  it("formats and caches an rgb() string per packed color", () => {
    const first = cssColor(color(1, 2, 3));
    const second = cssColor(color(1, 2, 3));
    expect(first).toBe("rgb(1, 2, 3)");
    expect(second).toBe(first);
  });
});

describe("snapToDevice", () => {
  it("rounds to the nearest whole device pixel", () => {
    expect(snapToDevice(10.2, 1.5)).toBeCloseTo(10, 5);
    expect(snapToDevice(3, 1)).toBe(3);
  });
});

function fakeCanvas(): Pick<HTMLCanvasElement, "style"> & { style: { backgroundColor?: string } } {
  return { style: {} as unknown as CSSStyleDeclaration } as unknown as Pick<
    HTMLCanvasElement,
    "style"
  > & { style: { backgroundColor?: string } };
}

describe("syncCanvasBackground", () => {
  it("writes the CSS background the first time it is asked", () => {
    const canvas = fakeCanvas();
    const background = color(20, 20, 20);
    const result = syncCanvasBackground(canvas, null, background);
    expect(canvas.style.backgroundColor).toContain("rgb(20 20 20");
    expect(result).toBe(background);
  });

  it("leaves the style alone when the ground has not moved", () => {
    const canvas = fakeCanvas();
    const previous = color(20, 20, 20);
    const result = syncCanvasBackground(canvas, previous, color(20, 20, 20));
    expect(canvas.style.backgroundColor).toBeUndefined();
    expect(result).toBe(previous);
  });

  it("writes again once the engine's default ground actually changes", () => {
    const canvas = fakeCanvas();
    const next = color(40, 40, 40);
    const result = syncCanvasBackground(canvas, color(20, 20, 20), next);
    expect(canvas.style.backgroundColor).toContain("rgb(40 40 40");
    expect(result).toBe(next);
  });
});

describe("renderGhosttySnapshot", () => {
  it("clears the whole canvas on a forced full repaint", () => {
    const { context, calls } = recordingContext(500, 200);
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row([cell({ text: "A" })])] }),
      metrics: metrics(),
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: true,
      cursorOn: false,
    });
    const clearIndex = calls.findIndex((entry) => entry.op === "clearRect" && entry.args[2] === 500);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(calls[clearIndex - 1]?.op).toBe("resetTransform");
    expect(calls[clearIndex + 1]?.op).toBe("restore");
  });

  it("lays a run's background down before its text within the same band", () => {
    const rowCells = [
      cell({ text: "A", background: color(80, 0, 0) }),
      cell({ text: "B", background: color(80, 0, 0) }),
    ];
    const { context, calls } = recordingContext();
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row(rowCells)], dirtyRows: new Set([0]) }),
      metrics: metrics(),
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });
    const backgroundIndex = calls.findIndex(
      (entry) => entry.op === "fillRect" && entry.style === "rgb(80, 0, 0)",
    );
    const textIndex = calls.findIndex((entry) => entry.op === "fillText");
    expect(backgroundIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(backgroundIndex);
  });

  it("clips a text run to its own cells plus the run-boundary bleed", () => {
    const rowCells = [cell({ text: "A" }), cell({ text: "B" }), cell({ text: "C" })];
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row(rowCells)], dirtyRows: new Set([0]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 5,
      forceFull: false,
      cursorOn: false,
    });
    const clipRect = calls.find((entry) => entry.op === "rect" && (entry.args[2] as number) < 100);
    expect(clipRect?.args).toEqual([5 - 5, 5 - 5, 30 + 10, 20 + 10]);
  });

  it("confines the cursor draw to its own cell", () => {
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({
        rowData: [row([cell({ text: "A" })])],
        cursorVisible: true,
        cursorX: 0,
        cursorY: 0,
        cursorStyle: 1,
        cursor: color(9, 9, 9),
      }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 5,
      forceFull: false,
      cursorOn: true,
    });
    const cursorFill = calls.find(
      (entry) => entry.op === "fillRect" && entry.style === "rgb(9, 9, 9)",
    );
    expect(cursorFill?.args).toEqual([5, 5, 10, 20]);
  });

  it("draws nothing for the cursor during its blink-off phase", () => {
    const { context, calls } = recordingContext();
    const cursorColor = color(9, 9, 9);
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({
        rowData: [row([cell({ text: "A" })])],
        cursorVisible: true,
        cursorX: 0,
        cursorY: 0,
        cursorStyle: 1,
        cursor: cursorColor,
      }),
      metrics: metrics(),
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });
    const cursorFill = calls.find(
      (entry) => (entry.op === "fillRect" || entry.op === "strokeRect") && entry.style === "rgb(9, 9, 9)",
    );
    expect(cursorFill).toBeUndefined();
  });

  it("repaints the row the cursor left even when nothing else marked it dirty", () => {
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({
        rowData: [row([cell({ text: "A" })]), row([cell({ text: "B" })])],
        dirtyRows: new Set(),
      }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 0,
      forceFull: false,
      cursorOn: true,
      previousCursorY: 1,
    });
    const clearedRow1 = calls.some((entry) => entry.op === "clearRect" && entry.args[1] === 20);
    expect(clearedRow1).toBe(true);
  });

  it("sizes hairline decorations in device pixels at a fractional DPR", () => {
    const rowCells = [cell({ text: "A", underline: true })];
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row(rowCells)], dirtyRows: new Set([0]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 0,
      forceFull: false,
      cursorOn: false,
      devicePixelRatio: 1.5,
    });
    const underline = fillRects(calls).find((entry) => (entry.args[3] as number) < 1);
    expect(underline?.args[3]).toBeCloseTo(1 / 1.5, 5);
    expect(underline?.args[1]).toBe(snapToDevice(0 + 20 - 2, 1.5));
  });

  it("clips a band vertically enough to spare accents and descenders, not the whole row height", () => {
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row([cell({ text: "A" })])], dirtyRows: new Set([0]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 0,
      forceFull: false,
      cursorOn: false,
    });
    const bandClip = calls.find((entry) => entry.op === "rect" && (entry.args[2] as number) >= 100);
    const verticalBleed = cellMetrics.height / 4;
    expect(bandClip?.args[1]).toBe(0);
    expect(bandClip?.args[3]).toBe(cellMetrics.height + verticalBleed);
  });

  it("redraws untouched neighbour rows a dirty row's band may bleed into", () => {
    const rows = [
      row([cell({ text: "top" })]),
      row([cell({ text: "middle" })]),
      row([cell({ text: "bottom" })]),
    ];
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: rows, dirtyRows: new Set([1]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 0,
      forceFull: false,
      cursorOn: false,
    });
    const clearedTops = calls
      .filter((entry) => entry.op === "clearRect")
      .map((entry) => entry.args[1]);
    expect(clearedTops).toEqual(expect.arrayContaining([0, 20, 40]));
  });

  it("clears the padding beyond the last column, not just the canvas width", () => {
    const { context, calls } = recordingContext(20, 50);
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: [row([cell({ text: "A" })])], dirtyRows: new Set([0]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 8,
      forceFull: false,
      cursorOn: false,
    });
    const rowClear = calls.find((entry) => entry.op === "clearRect" && entry.args[1] === 8);
    expect(rowClear?.args[2]).toBe(8 * 2 + 1 * 10 + 10);
  });

  it("underlines a hovered link across the row it wraps onto", () => {
    const rows = [row([cell({ text: "a" }), cell({ text: "b" })]), row([cell({ text: "c" }), cell({ text: "d" })])];
    const hoveredLinkRange: GhosttyCellRange = { start: { x: 1, y: 0 }, end: { x: 0, y: 1 } };
    const { context, calls } = recordingContext();
    const cellMetrics = metrics({ width: 10, height: 20 });
    renderGhosttySnapshot({
      context,
      snapshot: snapshot({ rowData: rows, dirtyRows: new Set([0, 1]) }),
      metrics: cellMetrics,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 0,
      forceFull: false,
      cursorOn: false,
      hoveredLinkRange,
    });
    const underlines = fillRects(calls).filter((entry) => (entry.args[3] as number) === 1);
    const firstRowLeft = underlines.find((entry) => entry.args[0] === 10 && entry.args[1] === 18);
    const secondRowLeft = underlines.find((entry) => entry.args[0] === 0 && entry.args[1] === 38);
    expect(firstRowLeft).toBeDefined();
    expect(secondRowLeft).toBeDefined();
  });
});
