// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { snapToDevice } from "./renderer";
import { GhosttyRuntime } from "./runtime";

const vendorDir = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasmBytes = readFileSync(`${vendorDir}ghostty-vt.wasm`);
const writePtyBytes = readFileSync(`${vendorDir}ghostty-write-pty.wasm`);

const THEME: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 },
};
const COLS = 120;
const ROWS = 24;
const PADDING = 4;
/** Consolas, the Windows fallback of the default font stack, advances 1126/2048 em. */
const CONSOLAS_ADVANCE = 1126 / 2048;

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function mouseReportingCore(cellWidth: number, cellHeight: number) {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const core = await GhosttyTerminalCore.create(COLS, ROWS, cellWidth, cellHeight, THEME, () => {}, runtime);
  cores.push(core);
  core.write("\x1b[?1000h\x1b[?1006h");
  return core;
}

/** The SGR report for a left press at the centre of a cell, with the geometry
 * `GhosttySurface.sendMouse` passes for a canvas at this device pixel ratio. */
function pressAtCellCentre(
  core: GhosttyTerminalCore,
  cell: { col: number; row: number },
  metrics: { width: number; height: number },
  devicePixelRatio: number,
): string {
  const screenWidth = PADDING * 2 + COLS * metrics.width + metrics.width / 2;
  const screenHeight = PADDING * 2 + ROWS * metrics.height;
  return core.encodeMouse({
    action: "press",
    button: 1,
    mods: 0,
    x: PADDING + (cell.col + 0.5) * metrics.width,
    y: PADDING + (cell.row + 0.5) * metrics.height,
    screenWidth,
    screenHeight,
    cellWidth: metrics.width,
    cellHeight: metrics.height,
    paddingLeft: PADDING,
    paddingRight: PADDING,
    paddingTop: PADDING,
    paddingBottom: screenHeight - PADDING - ROWS * metrics.height,
    anyButtonPressed: true,
    devicePixelRatio,
  });
}

describe("mouse reports at fractional device pixel ratios", () => {
  // A device-snapped cell is fractional in CSS pixels; rounding it to whole CSS
  // pixels drifted reports with the column (13 px at 150%: 84 for 80; 12 px: 76).
  it.each([
    { fontSize: 13, devicePixelRatio: 1.5 },
    { fontSize: 12, devicePixelRatio: 1.5 },
    { fontSize: 16, devicePixelRatio: 1.25 },
    { fontSize: 13, devicePixelRatio: 1.75 },
    { fontSize: 13, devicePixelRatio: 1 },
  ])("reports the cell under the pointer at $fontSize px and DPR $devicePixelRatio", async ({
    fontSize,
    devicePixelRatio,
  }) => {
    const metrics = {
      width: snapToDevice(CONSOLAS_ADVANCE * fontSize, devicePixelRatio),
      height: snapToDevice(Math.round(fontSize * 1.35), devicePixelRatio),
    };
    const core = await mouseReportingCore(metrics.width, metrics.height);

    for (const cell of [
      { col: 0, row: 0 },
      { col: 80, row: 20 },
      { col: COLS - 1, row: ROWS - 1 },
    ]) {
      expect(pressAtCellCentre(core, cell, metrics, devicePixelRatio)).toBe(
        `\x1b[<0;${cell.col + 1};${cell.row + 1}M`,
      );
    }
  });
});
