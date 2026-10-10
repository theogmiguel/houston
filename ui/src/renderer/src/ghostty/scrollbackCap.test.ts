// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { GhosttyRuntime } from "./runtime";
import { scrollbackLinesToBytes } from "./surface";

const vendorDir = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasmBytes = readFileSync(`${vendorDir}ghostty-vt.wasm`);
const writePtyBytes = readFileSync(`${vendorDir}ghostty-write-pty.wasm`);

const THEME: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 },
};

const LINES = 10_000;

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function narrowCore(): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const created = await GhosttyTerminalCore.create(8, 11, 8, 17, THEME, () => {}, runtime, {
    maxScrollback: scrollbackLinesToBytes(LINES, 8),
  });
  cores.push(created);
  return created;
}

function writeRows(terminal: GhosttyTerminalCore, count: number): void {
  let chunk = "";
  for (let i = 1; i <= count; i++) {
    chunk += `row ${String(i).padStart(5, "0")} ${"x".repeat(100)}\r\n`;
    if (chunk.length > 65536) {
      terminal.write(chunk);
      chunk = "";
    }
  }
  terminal.write(chunk);
}

function keptRows(terminal: GhosttyTerminalCore): number {
  terminal.selectAll();
  return terminal.selectionText().split("\n").filter((line) => line.startsWith("row ")).length;
}

describe("scrollback cap", () => {
  it("a pane opened narrow keeps its configured lines once widened", async () => {
    const terminal = await narrowCore();
    terminal.resize(200, 50, 8, 17);
    terminal.setMaxScrollback(scrollbackLinesToBytes(LINES, 200));

    writeRows(terminal, 3000);

    expect(keptRows(terminal)).toBe(3000);
  });

  it("shrinking the cap drops the oldest history at once and keeps the newest", async () => {
    const terminal = await narrowCore();
    terminal.resize(200, 50, 8, 17);
    terminal.setMaxScrollback(scrollbackLinesToBytes(LINES, 200));
    writeRows(terminal, 3000);

    terminal.setMaxScrollback(scrollbackLinesToBytes(100, 200));

    const kept = keptRows(terminal);
    expect(kept).toBeGreaterThan(50);
    expect(kept).toBeLessThan(3000);
    expect(terminal.selectionText()).toContain("row 03000");
  });
});
