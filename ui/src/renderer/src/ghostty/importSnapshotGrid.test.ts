// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GhosttyTerminalCore, ghosttyRowText, type GhosttyTheme } from "./core";
import { GhosttyRuntime } from "./runtime";

const vendorDir = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasmBytes = readFileSync(`${vendorDir}ghostty-vt.wasm`);
const writePtyBytes = readFileSync(`${vendorDir}ghostty-write-pty.wasm`);

const THEME: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 },
};

const SPAWN = { cols: 80, rows: 24 };
const MEASURED = { cols: 205, rows: 49 };

const CELL_WIDTH = 8;
const CELL_HEIGHT = 19;

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function core(cols: number, rows: number): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const created = await GhosttyTerminalCore.create(
    cols,
    rows,
    CELL_WIDTH,
    CELL_HEIGHT,
    THEME,
    () => {},
    runtime,
  );
  cores.push(created);
  return created;
}

async function containerAt(cols: number, rows: number): Promise<Uint8Array> {
  const source = await core(cols, rows);
  const state = source.exportSnapshot(0);
  expect(state).not.toBeNull();
  return state!;
}

function drawFullWidthRule(terminal: GhosttyTerminalCore, cols: number): void {
  terminal.write("\x1b[?1049h\x1b[2J\x1b[H");
  terminal.write("─".repeat(cols));
}

describe("importing a snapshot container", () => {
  it("applies the container's grid, not the terminal's -- which is why a foreign one has to be refused", async () => {
    const container = await containerAt(SPAWN.cols, SPAWN.rows);
    const pane = await core(MEASURED.cols, MEASURED.rows);
    expect(pane.gridSize()).toEqual(MEASURED);

    expect(pane.importSnapshot(container)).toBe(true);

    expect(pane.gridSize()).toEqual(SPAWN);
  });

  it("leaves the grid alone when the container was captured at the same size", async () => {
    const container = await containerAt(MEASURED.cols, MEASURED.rows);
    const pane = await core(MEASURED.cols, MEASURED.rows);

    expect(pane.importSnapshot(container)).toBe(true);

    expect(pane.gridSize()).toEqual(MEASURED);
  });

  it("a terminal left at the container's grid wraps a full-width rule; the surface's recovery unwraps it", async () => {
    const container = await containerAt(SPAWN.cols, SPAWN.rows);
    const pane = await core(MEASURED.cols, MEASURED.rows);
    pane.importSnapshot(container);

    drawFullWidthRule(pane, MEASURED.cols);
    pane.resize(MEASURED.cols, MEASURED.rows, CELL_WIDTH, CELL_HEIGHT);
    const wrapped = pane.snapshot();
    expect(ghosttyRowText(wrapped.rowData[0]!)).toHaveLength(SPAWN.cols);
    expect(ghosttyRowText(wrapped.rowData[1]!)).toHaveLength(SPAWN.cols);

    pane.resetAndWrite("");
    pane.resize(MEASURED.cols, MEASURED.rows, CELL_WIDTH, CELL_HEIGHT);
    expect(pane.gridSize()).toEqual(MEASURED);

    drawFullWidthRule(pane, MEASURED.cols);
    const repaired = pane.snapshot();
    expect(ghosttyRowText(repaired.rowData[0]!)).toHaveLength(MEASURED.cols);
    expect(ghosttyRowText(repaired.rowData[1]!)).toBe("");
  });
});
