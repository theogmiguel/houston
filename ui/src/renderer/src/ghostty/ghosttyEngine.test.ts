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

const ANSI_SAMPLE = "Hello\r\n\x1b[31mRed\x1b[0m\r\n";

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function createSpikeCore(): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const core = await GhosttyTerminalCore.create(
    80,
    24,
    8,
    17,
    THEME,
    () => {
    },
    runtime,
  );
  cores.push(core);
  return core;
}

describe("ghostty-spike: libghostty-vt loads and parses under Houston's toolchain", () => {
  it("loads the wasm module and creates a terminal handle", async () => {
    const core = await createSpikeCore();
    const snapshot = core.snapshot();
    expect(snapshot.cols).toBe(80);
    expect(snapshot.rows).toBe(24);
  });

  it("write() applies synchronously -- the next snapshot() call (no await) sees it", async () => {
    const core = await createSpikeCore();
    core.write(ANSI_SAMPLE);
    const snapshot = core.snapshot();

    expect(ghosttyRowText(snapshot.rowData[0]!).startsWith("Hello")).toBe(true);
    expect(ghosttyRowText(snapshot.rowData[1]!).startsWith("Red")).toBe(true);
  });

  it("dirtyRows reports exactly the rows the write touched", async () => {
    const core = await createSpikeCore();
    core.snapshot();
    core.write(ANSI_SAMPLE);
    const snapshot = core.snapshot();

    expect(snapshot.dirtyRows.has(0)).toBe(true);
    expect(snapshot.dirtyRows.has(1)).toBe(true);
    expect(snapshot.dirtyRows.size).toBeLessThan(24);
  });

  it("carries SGR color state into the styled row's cells", async () => {
    const core = await createSpikeCore();
    core.write(ANSI_SAMPLE);
    const snapshot = core.snapshot();

    const redCell = snapshot.rowData[1]?.cells[0];
    expect(redCell).toBeDefined();
    expect(redCell!.foreground.r).toBeGreaterThan(redCell!.foreground.g);
    expect(redCell!.foreground.r).toBeGreaterThan(redCell!.foreground.b);
  });

  it("exposes scrollback: rows scrolled out of the viewport are still readable", async () => {
    const core = await createSpikeCore();
    let out = "";
    for (let i = 1; i <= 60; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);

    const scrollbar = core.scrollbarState();
    expect(scrollbar).not.toBeNull();
    expect(scrollbar!.total).toBeGreaterThan(24);

    const snapshot = core.snapshot();
    expect(snapshot.rowData.some((row) => ghosttyRowText(row).includes("line 001"))).toBe(false);

    core.setSelection({ x: 0, y: 0, tag: 2 }, { x: 79, y: 0, tag: 2 });
    expect(core.selectionText()).toContain("line 001");

    core.selectAll();
    const all = core.selectionText();
    expect(all).toContain("line 001");
    expect(all).toContain("line 060");
  });

  it("resetAndWrite() clears prior content before replaying new bytes", async () => {
    const core = await createSpikeCore();
    core.write("stale content\r\n");
    core.resetAndWrite("fresh\r\n");
    const snapshot = core.snapshot();

    expect(ghosttyRowText(snapshot.rowData[0]!).startsWith("fresh")).toBe(true);
    expect(snapshot.rowData.some((row) => ghosttyRowText(row).includes("stale"))).toBe(false);
  });

  it("honors defaultCursorBlink:false at construction -- option 23 stays off, not the unconditional default", async () => {
    const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
    const core = await GhosttyTerminalCore.create(80, 24, 8, 17, THEME, () => {}, runtime, {
      defaultCursorBlink: false,
    });
    cores.push(core);
    expect(core.snapshot().cursorBlinking).toBe(false);
  });

  it("defaults to a blinking cursor when defaultCursorBlink is omitted (unchanged behaviour)", async () => {
    const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
    const core = await GhosttyTerminalCore.create(80, 24, 8, 17, THEME, () => {}, runtime);
    cores.push(core);
    expect(core.snapshot().cursorBlinking).toBe(true);
  });

  it("honors maxScrollback:0 at construction -- no history is retained, not the ~10,000-row default", async () => {
    const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
    const core = await GhosttyTerminalCore.create(80, 24, 8, 17, THEME, () => {}, runtime, {
      maxScrollback: 0,
    });
    cores.push(core);
    let out = "";
    for (let i = 1; i <= 60; i += 1) out += `line ${String(i).padStart(3, "0")}\r\n`;
    core.write(out);
    expect(core.scrollbarState()?.total).toBe(24);
  });
});
