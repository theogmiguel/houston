// @vitest-environment node
import { describe, expect, it } from "vitest";

import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from "./core";
import { drawCustomGlyph, isCustomGlyph } from "./customGlyphs";
import { renderGhosttySnapshot } from "./renderer";

interface RecordedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

function recordingContext(): {
  context: CanvasRenderingContext2D;
  fills: RecordedRect[];
  texts: unknown[][];
  clips: number[][];
  strokes: number;
} {
  const fills: RecordedRect[] = [];
  const texts: unknown[][] = [];
  const clips: number[][] = [];
  let alpha = 1;
  const recorder = {
    strokes: 0,
    canvas: { width: 400, height: 100 },
    beginPath: () => {},
    clip: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    stroke: () => {
      recorder.strokes += 1;
    },
    fillRect: (x: number, y: number, w: number, h: number) => fills.push({ x, y, w, h, alpha }),
    clearRect: (x: number, y: number, w: number, h: number) => fills.push({ x, y, w, h, alpha }),
    fillText: (...args: unknown[]) => texts.push(args),
    rect: (...args: number[]) => clips.push(args),
    resetTransform: () => {},
    restore: () => {
      alpha = 1;
    },
    save: () => {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    set globalAlpha(value: number) {
      alpha = value;
    },
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  };
  return {
    context: recorder as unknown as CanvasRenderingContext2D,
    fills,
    texts,
    clips,
    get strokes() {
      return recorder.strokes;
    },
  };
}

describe("isCustomGlyph", () => {
  it("claims exactly the box-drawing and block-element ranges", () => {
    expect(isCustomGlyph("─")).toBe(true);
    expect(isCustomGlyph("▟")).toBe(true);
    expect(isCustomGlyph("⓿")).toBe(false);
    expect(isCustomGlyph("■")).toBe(false);
    expect(isCustomGlyph("a")).toBe(false);
    expect(isCustomGlyph("──")).toBe(false);
  });
});

describe("drawCustomGlyph primitives", () => {
  const CELL = { x: 10, y: 20, w: 8, h: 17 };

  it("fills the FULL cell for U+2588, stripe-free by construction", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "█", CELL.x, CELL.y, CELL.w, CELL.h);
    expect(fills).toEqual([{ x: 10, y: 20, w: 8, h: 17, alpha: 1 }]);
  });

  it("meets halves with no seam: ▀ above ▄ covers every scanline once over", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "▀", CELL.x, CELL.y, CELL.w, CELL.h);
    drawCustomGlyph(context, "▄", CELL.x, CELL.y, CELL.w, CELL.h);
    const [upper, lower] = fills;
    expect(upper!.y).toBe(CELL.y);
    expect(lower!.y).toBeLessThanOrEqual(upper!.y + upper!.h);
    expect(lower!.y + lower!.h).toBe(CELL.y + CELL.h);
  });

  it("draws light box lines through the cell center at full extent", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "─", CELL.x, CELL.y, CELL.w, CELL.h);
    expect(fills).toHaveLength(2);
    const [left, right] = fills;
    expect(Math.min(left!.x, right!.x)).toBe(CELL.x);
    expect(Math.max(left!.x + left!.w, right!.x + right!.w)).toBe(CELL.x + CELL.w);
    expect(left!.h).toBe(right!.h);
    expect(left!.h).toBeLessThan(CELL.h / 4);
  });

  it("draws a corner as one vertical and one horizontal arm", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "┌", CELL.x, CELL.y, CELL.w, CELL.h);
    expect(fills).toHaveLength(2);
    const vertical = fills.find((f) => f.h > f.w)!;
    const horizontal = fills.find((f) => f.w > f.h)!;
    expect(vertical.y + vertical.h).toBe(CELL.y + CELL.h);
    expect(horizontal.x + horizontal.w).toBe(CELL.x + CELL.w);
  });

  it("draws quadrant blocks as exact quarter fills", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "▛", CELL.x, CELL.y, CELL.w, CELL.h);
    expect(fills).toHaveLength(3);
    const midX = Math.round(CELL.w / 2);
    const midY = Math.round(CELL.h / 2);
    const area = fills.reduce((sum, f) => sum + f.w * f.h, 0);
    expect(area).toBe(CELL.w * CELL.h - (CELL.w - midX) * (CELL.h - midY));
    for (const f of fills) {
      expect(f.x + f.w <= CELL.x + midX || f.y + f.h <= CELL.y + midY).toBe(true);
    }
  });

  it("draws shades as alpha fills of the whole cell", () => {
    const { context, fills } = recordingContext();
    drawCustomGlyph(context, "▒", CELL.x, CELL.y, CELL.w, CELL.h);
    expect(fills).toEqual([{ x: 10, y: 20, w: 8, h: 17, alpha: 0.5 }]);
  });

  it("strokes rounded corners and diagonals instead of rect arms", () => {
    const arcs = recordingContext();
    expect(drawCustomGlyph(arcs.context, "╭", CELL.x, CELL.y, CELL.w, CELL.h)).toBe(true);
    expect(arcs.strokes).toBe(1);
    const diag = recordingContext();
    expect(drawCustomGlyph(diag.context, "╳", CELL.x, CELL.y, CELL.w, CELL.h)).toBe(true);
    expect(diag.strokes).toBe(1);
  });

  it("covers the whole claimed range: every claimed codepoint draws something", () => {
    for (let code = 0x2500; code <= 0x259f; code += 1) {
      const recorder = recordingContext();
      const drew = drawCustomGlyph(recorder.context, String.fromCharCode(code), 0, 0, 8, 16);
      expect(drew, `U+${code.toString(16)}`).toBe(true);
      expect(
        recorder.fills.length + recorder.strokes,
        `U+${code.toString(16)} drew nothing`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("renderer routing", () => {
  const glyphCell = (text: string): GhosttyCell => ({
    text,
    wide: GHOSTTY_CELL_WIDE.narrow ?? 0,
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false,
  });

  function snapshotOf(cells: GhosttyCell[]): GhosttySnapshot {
    return {
      cols: cells.length,
      rows: 1,
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [
        {
          cells,
          text: cells.map((c) => c.text).join(""),
          isWrapContinuation: false,
          wrapsToNext: false,
        },
      ],
    };
  }

  const METRICS = { width: 10, height: 20, baseline: 15 };

  it("sends block glyphs to primitives, never to fillText (the logo defect)", () => {
    const { context, fills, texts } = recordingContext();
    renderGhosttySnapshot({
      context,
      snapshot: snapshotOf([glyphCell("a"), glyphCell("█"), glyphCell("b")]),
      metrics: METRICS,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });
    expect(fills).toContainEqual({ x: 14, y: 4, w: 10, h: 20, alpha: 1 });
    expect(texts.map((t) => t[0])).toEqual(["a", "b"]);
  });

  it("gives text-run clips half a cell of bleed so run-edge ink is not shaved", () => {
    const { context, clips } = recordingContext();
    renderGhosttySnapshot({
      context,
      snapshot: snapshotOf([glyphCell("a"), glyphCell("b")]),
      metrics: METRICS,
      fontSize: 12,
      fontFamily: "monospace",
      padding: 4,
      forceFull: false,
      cursorOn: false,
    });
    expect(clips).toHaveLength(2);
    expect(clips[1]).toEqual([4 - 5, 4 - 5, 20 + 10, 20 + 10]);
  });
});
