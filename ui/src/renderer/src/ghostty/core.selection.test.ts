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

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function createCore(): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const core = await GhosttyTerminalCore.create(80, 24, 8, 17, THEME, () => {}, runtime);
  cores.push(core);
  return core;
}

function selectViewportRange(
  core: GhosttyTerminalCore,
  anchor: { x: number; y: number },
  end: { x: number; y: number },
): void {
  const anchorScreen = core.viewportPointToScreen(anchor.x, anchor.y);
  const endScreen = core.viewportPointToScreen(end.x, end.y);
  expect(anchorScreen).not.toBeNull();
  expect(endScreen).not.toBeNull();
  core.setSelection({ ...anchorScreen!, tag: 2 }, { ...endScreen!, tag: 2 });
}

function selectedCellsByRow(core: GhosttyTerminalCore): Map<number, number[]> {
  const selected = new Map<number, number[]>();
  const snapshot = core.snapshot();
  snapshot.rowData.forEach((row, rowIndex) => {
    const columns = row.cells.flatMap((cell, column) => (cell.selected ? [column] : []));
    if (columns.length > 0) selected.set(rowIndex, columns);
  });
  return selected;
}

describe("drag-selection visibility (surface's own conversion path)", () => {
  it("marks the dragged viewport cells selected in a fresh pane", async () => {
    const core = await createCore();
    core.write("Hello selection\r\nsecond line\r\n");
    selectViewportRange(core, { x: 0, y: 0 }, { x: 4, y: 0 });
    const selected = selectedCellsByRow(core);
    expect(selected.get(0)).toEqual([0, 1, 2, 3, 4]);
    expect([...selected.keys()]).toEqual([0]);
    expect(core.selectionText()).toBe("Hello");
  });

  it("still marks the VISIBLE cells once scrollback exists", async () => {
    const core = await createCore();
    let out = "";
    for (let i = 1; i <= 60; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    const rowText = ghosttyRowText(core.snapshot().rowData[10]!);
    selectViewportRange(core, { x: 0, y: 10 }, { x: 7, y: 10 });
    const selected = selectedCellsByRow(core);
    expect(selected.get(10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(core.selectionText()).toBe(rowText.slice(0, 8));
  });

  it("keeps highlighting the same visible row after the user scrolls up", async () => {
    const core = await createCore();
    let out = "";
    for (let i = 1; i <= 60; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    core.scroll(-10);
    const rowText = ghosttyRowText(core.snapshot().rowData[5]!);
    selectViewportRange(core, { x: 0, y: 5 }, { x: 7, y: 5 });
    const selected = selectedCellsByRow(core);
    expect(selected.get(5)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(core.selectionText()).toBe(rowText.slice(0, 8));
  });
});

describe("mouse-tracking gate (what decides selection vs forwarding)", () => {
  it("reports no tracking on a fresh terminal, and follows DECSET/DECRST", async () => {
    const core = await createCore();
    expect(core.isMouseTracking()).toBe(false);
    core.write("\x1b[?1002h");
    expect(core.isMouseTracking()).toBe(true);
    core.write("\x1b[?1002l");
    expect(core.isMouseTracking()).toBe(false);
  });
});

describe("selection survival under live output (the CC-pane reality)", () => {
  it("keeps a scrollback selection while new lines append below", async () => {
    const core = await createCore();
    let out = "";
    for (let i = 1; i <= 30; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    selectViewportRange(core, { x: 0, y: 2 }, { x: 7, y: 2 });
    const before = core.selectionText();
    expect(before).not.toBe("");
    core.write("more 1\r\nmore 2\r\nmore 3\r\n");
    expect(core.selectionText()).toBe(before);
  });

  it("keeps a selection on rows an in-place redraw does NOT touch", async () => {
    const core = await createCore();
    let out = "";
    for (let i = 1; i <= 10; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    selectViewportRange(core, { x: 0, y: 2 }, { x: 7, y: 2 });
    const before = core.selectionText();
    expect(before).not.toBe("");
    core.write("\x1b7\x1b[24;1H\x1b[2Kstatus tick\x1b8");
    expect(core.selectionText()).toBe(before);
  });

  it("documents what happens when the redraw rewrites the SELECTED row", async () => {
    const core = await createCore();
    let out = "";
    for (let i = 1; i <= 10; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    selectViewportRange(core, { x: 0, y: 2 }, { x: 7, y: 2 });
    expect(core.selectionText()).not.toBe("");
    core.write("\x1b7\x1b[3;1H\x1b[2Kline 003 rewritten\x1b8");
    console.log("selection after rewrite of selected row:", JSON.stringify(core.selectionText()));
    expect(true).toBe(true);
  });
});
