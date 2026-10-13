// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ghosttyThemeFromCss } from "../pane/ghosttyTerminal";
import { TERMINAL_PALETTES, THEMES } from "../theme";
import { GhosttyTerminalCore, type GhosttyColor, type GhosttyTheme } from "./core";
import { GhosttyRuntime } from "./runtime";

const vendor = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasm = readFileSync(`${vendor}ghostty-vt.wasm`);
const writer = readFileSync(`${vendor}ghostty-write-pty.wasm`);
const names = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
] as const;
const rgb = (hex: string): GhosttyColor => ({
  r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
});
const theme = (name: typeof THEMES[number]) => ghosttyThemeFromCss(TERMINAL_PALETTES[name]);
const smallTheme: GhosttyTheme = {
  foreground: { r: 229, g: 231, b: 235 }, background: { r: 12, g: 12, b: 12 },
  cursor: { r: 255, g: 255, b: 255 },
};
let cores: GhosttyTerminalCore[] = [];
afterEach(() => { cores.forEach(core => core.dispose()); cores = []; });

async function create(initial: GhosttyTheme = smallTheme) {
  const runtime = await GhosttyRuntime.loadFromBytes(wasm, writer);
  const core = await GhosttyTerminalCore.create(256, 8, 8, 17, initial, () => {}, runtime);
  cores.push(core);
  return core;
}

function indexedCells(core: GhosttyTerminalCore) {
  core.write(Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}mX`).join("") + "\x1b[0m\r\n");
  core.write(Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 40 + i : 100 + i - 8}mX`).join("") + "\x1b[0m\r\n");
  core.write(Array.from({ length: 256 }, (_, i) => `\x1b[38;5;${i}mX`).join("") + "\x1b[0m\r\n");
  core.write(Array.from({ length: 256 }, (_, i) => `\x1b[48;5;${i}mX`).join("") + "\x1b[0m\r\n");
  core.write("\x1b[38;2;10;20;30;48;2;40;50;60mX\x1b[0m");
}

function expectAnsi(core: GhosttyTerminalCore, preset: typeof THEMES[number], overrides: Record<number, GhosttyColor> = {}) {
  const rows = core.snapshot().rowData;
  names.forEach((name, i) => {
    const expected = overrides[i] ?? rgb(TERMINAL_PALETTES[preset][name]!);
    expect(rows[0].cells[i].foreground, `${preset} SGR foreground ${i}`).toEqual(expected);
    expect(rows[1].cells[i].background, `${preset} SGR background ${i}`).toEqual(expected);
    expect(rows[2].cells[i].foreground, `${preset} indexed foreground ${i}`).toEqual(expected);
    expect(rows[3].cells[i].background, `${preset} indexed background ${i}`).toEqual(expected);
  });
}

function fixedColors(core: GhosttyTerminalCore) {
  const rows = core.snapshot().rowData;
  return {
    foreground: rows[2].cells.slice(16).map(cell => cell.foreground),
    background: rows[3].cells.slice(16).map(cell => cell.background),
    truecolor: [rows[4].cells[0].foreground, rows[4].cells[0].background],
  };
}

describe("ANSI defaults in real libghostty WASM", () => {
  it.each(THEMES)("renders all sixteen ANSI foregrounds and backgrounds in %s", async preset => {
    const core = await create(theme(preset));
    indexedCells(core);
    expectAnsi(core, preset);
  });

  it("recolors existing indexed cells across dark/light themes, preserving 16..255 and RGB", async () => {
    const core = await create();
    indexedCells(core);
    const fixed = fixedColors(core);
    for (const preset of ["black", "marble", "light", "dracula", "black"] as const) {
      core.setTheme(theme(preset));
      expectAnsi(core, preset);
      expect(fixedColors(core)).toEqual(fixed);
    }
    expect(fixed.truecolor).toEqual([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }]);
  });

  it("preserves OSC 4 overrides, including an explicit value equal to the old default, until OSC 104", async () => {
    const core = await create(theme("black"));
    const explicitDefault = rgb(TERMINAL_PALETTES.black.red!);
    core.write(`\x1b]4;1;${TERMINAL_PALETTES.black.red};2;#123456;114;#654321\x07`);
    indexedCells(core);
    core.setTheme(theme("marble"));
    expectAnsi(core, "marble", { 1: explicitDefault, 2: rgb("#123456") });
    expect(core.snapshot().rowData[2].cells[114].foreground).toEqual(rgb("#654321"));
    core.write("\x1b]104;1\x07");
    expectAnsi(core, "marble", { 2: rgb("#123456") });
    core.write("\x1b]104\x07");
    expectAnsi(core, "marble");
    expect(core.snapshot().rowData[2].cells[114].foreground).toEqual({ r: 135, g: 215, b: 135 });
  });

  it("keeps defaults local when importing a daemon-equivalent snapshot before or after theme application", async () => {
    const source = await create();
    indexedCells(source);
    const state = source.exportSnapshot(0)!;
    for (const applyBeforeImport of [true, false]) {
      const restored = await create();
      if (applyBeforeImport) restored.setTheme(theme("marble"));
      expect(restored.importSnapshot(state)).toBe(true);
      if (!applyBeforeImport) restored.setTheme(theme("marble"));
      expectAnsi(restored, "marble");
      restored.setTheme(theme("black"));
      expectAnsi(restored, "black");
      expect(fixedColors(restored)).toEqual(fixedColors(source));
    }
  });

  it("restores genuine palette/dynamic overrides and clears stale overrides on the next import", async () => {
    const source = await create(theme("black"));
    indexedCells(source);
    const clean = source.exportSnapshot(0)!;
    source.write(`\x1b]4;1;${TERMINAL_PALETTES.black.red};2;#123456;114;#654321\x07`);
    source.write("\x1b]10;#112233\x07\x1b]11;#445566\x07\x1b]12;#778899\x07");
    const restored = await create(theme("marble"));
    restored.write("\x1b]4;3;#abcdef\x07\x1b]10;#abcdef\x07");
    expect(restored.importSnapshot(source.exportSnapshot(0)!)).toBe(true);
    restored.setTheme(theme("light"));
    expectAnsi(restored, "light", { 1: rgb(TERMINAL_PALETTES.black.red!), 2: rgb("#123456") });
    expect(restored.snapshot().rowData[2].cells[114].foreground).toEqual(rgb("#654321"));
    expect(restored.snapshot()).toMatchObject({ foreground: rgb("#112233"), background: rgb("#445566"), cursor: rgb("#778899") });
    restored.write("\x1b]4;3;#abcdef\x07");
    expectAnsi(restored, "light", {
      1: rgb(TERMINAL_PALETTES.black.red!), 2: rgb("#123456"), 3: rgb("#abcdef"),
    });
    restored.write("\x1b]104;3\x07");
    restored.write("\x1b]104;2\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07");
    expectAnsi(restored, "light", { 1: rgb(TERMINAL_PALETTES.black.red!) });
    expect(restored.snapshot()).toMatchObject({
      foreground: theme("light").foreground,
      background: theme("light").background,
      cursor: theme("light").cursor,
    });
    restored.write("\x1b]10;#abcdef\x07\x1b]11;#abcdef\x07\x1b]12;#abcdef\x07");
    expect(restored.importSnapshot(clean)).toBe(true);
    expectAnsi(restored, "light");
    expect(restored.snapshot()).toMatchObject({
      foreground: theme("light").foreground,
      background: theme("light").background,
      cursor: theme("light").cursor,
    });
  });
});
