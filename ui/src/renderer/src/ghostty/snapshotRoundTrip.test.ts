// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { GhosttyRuntime } from "./runtime";

const vendorDir = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasmBytes = readFileSync(`${vendorDir}ghostty-vt.wasm`);
const writePtyBytes = readFileSync(`${vendorDir}ghostty-write-pty.wasm`);

const THEME: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 },
  background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 },
};

const COLS = 32;
const ROWS = 11;

let cores: GhosttyTerminalCore[] = [];

afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function core(maxScrollback?: number): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const created = await GhosttyTerminalCore.create(COLS, ROWS, 8, 17, THEME, () => {}, runtime, {
    maxScrollback,
  });
  cores.push(created);
  return created;
}

function allText(terminal: GhosttyTerminalCore): string {
  terminal.selectAll();
  return terminal.selectionText().trimEnd();
}

describe("snapshot round trip", () => {
  it("keeps soft-wrapped lines as one logical line in history and on screen", async () => {
    const source = await core();
    for (let i = 1; i <= 40; i++) {
      source.write(
        `\x1b[3${(i % 7) + 1}mline ${String(i).padStart(4, "0")}\x1b[0m ` +
          "lorem ipsum dolor sit amet consectetur adipiscing elit\r\n",
      );
    }
    source.write("a final line long enough to wrap past the thirty-two column edge");

    const restored = await core();
    expect(restored.importSnapshot(source.exportSnapshot(1000)!)).toBe(true);

    expect(allText(restored)).toBe(allText(source));
  });

  it("keeps the newest rows when the history outgrows the importer's scrollback", async () => {
    const source = await core(4 * 1024 * 1024);
    for (let i = 1; i <= 3000; i++) {
      source.write(`\x1b[3${(i % 7) + 1}mrow ${String(i).padStart(5, "0")}\x1b[0m lorem ipsum dolor\r\n`);
    }
    source.write("END");

    const restored = await core(64 * 1024);
    expect(restored.importSnapshot(source.exportSnapshot(10_000)!)).toBe(true);

    const text = allText(restored);
    expect(text.endsWith("row 03000 lorem ipsum dolor\nEND")).toBe(true);
    const kept = text.split("\n").filter((line) => line.startsWith("row ")).length;
    expect(kept).toBeGreaterThan(ROWS);
    expect(kept).toBeLessThan(3000);
  });
});
