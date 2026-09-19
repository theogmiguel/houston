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

const PROMPT = "X dev@devbox-01 ~/../Houston  main > ";
const PROMPT_HEAD = "X dev@devbox-01";
const LONG_OUTPUT_LINE = "a-long-output-line-that-should-still-reflow-when-narrowed";

let cores: GhosttyTerminalCore[] = [];
afterEach(() => {
  for (const core of cores) core.dispose();
  cores = [];
});

async function makeCore(cols: number, rows: number): Promise<GhosttyTerminalCore> {
  const runtime = await GhosttyRuntime.loadFromBytes(wasmBytes, writePtyBytes);
  const core = await GhosttyTerminalCore.create(cols, rows, 8, 17, THEME, () => {
  }, runtime);
  cores.push(core);
  return core;
}

function logicalLines(core: GhosttyTerminalCore): string[] {
  const rows = core.snapshot().rowData;
  const lines: string[] = [];
  let current = "";
  for (const row of rows) {
    const raw = row.cells.map((cell) => cell.text || " ").join("");
    current += row.wrapsToNext ? raw : raw.trimEnd();
    if (!row.wrapsToNext) {
      lines.push(current);
      current = "";
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function promptRowStarts(core: GhosttyTerminalCore, head: string): number {
  return core.snapshot().rowData.filter((row) => ghosttyRowText(row).startsWith(head)).length;
}

describe("shell_redraws_prompt opt-in: resize + zsh SIGWINCH redraw", () => {
  it("plain 133;A prompt (as oh-my-posh emits) survives narrowing without duplicating", async () => {
    const core = await makeCore(60, 8);
    core.write("first line of scrollback\r\n");
    core.write("\x1b]133;A\x07" + PROMPT);
    core.resize(34, 8, 8, 17);
    core.write("\r\r\x1b[0m\x1b[J\x1b]133;A\x07" + PROMPT);

    expect(promptRowStarts(core, PROMPT_HEAD)).toBe(1);
    expect(logicalLines(core)).toContain("first line of scrollback");
  });

  it("command output (after 133;C) still reflows across rows -- nothing is cleared", async () => {
    const core = await makeCore(60, 8);
    core.write("\x1b]133;A\x07" + PROMPT + "\x1b]133;B\x07");
    core.write("cargo test\r\n\x1b]133;C\x07");
    core.write(LONG_OUTPUT_LINE + "\r\n");
    core.resize(34, 8, 8, 17);

    expect(logicalLines(core)).toContain(LONG_OUTPUT_LINE);
    expect(promptRowStarts(core, PROMPT_HEAD)).toBe(1);
  });

  it("survives resetAndWrite()'s RIS replay too -- the opt-in is re-injected before the replay", async () => {
    const core = await makeCore(60, 8);
    core.resetAndWrite("first line of scrollback\r\n\x1b]133;A\x07" + PROMPT);
    core.resize(34, 8, 8, 17);
    core.write("\r\r\x1b[0m\x1b[J\x1b]133;A\x07" + PROMPT);

    expect(promptRowStarts(core, PROMPT_HEAD)).toBe(1);
    expect(logicalLines(core)).toContain("first line of scrollback");
  });
});
