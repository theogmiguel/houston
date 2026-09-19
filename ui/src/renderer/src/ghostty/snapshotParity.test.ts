// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GhosttyTerminalCore, type GhosttyTheme } from "./core";
import { GhosttyRuntime } from "./runtime";

const vendorDir = fileURLToPath(new URL("./vendor/", import.meta.url));
const wasmBytes = readFileSync(`${vendorDir}ghostty-vt.wasm`);
const writePtyBytes = readFileSync(`${vendorDir}ghostty-write-pty.wasm`);

const fixturePath = fileURLToPath(
  new URL("../../../../../core/houston-core/tests/fixtures/vt_snapshots.json", import.meta.url),
);
const fixture: {
  cols: number;
  rows: number;
  formatVersion: number;
  historyRows: number;
  scenarios: { name: string; a: string; b: string; snapshot: string }[];
} = JSON.parse(readFileSync(fixturePath, "utf8"));

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
  const core = await GhosttyTerminalCore.create(
    fixture.cols,
    fixture.rows,
    8,
    17,
    THEME,
    () => {},
    runtime,
  );
  cores.push(core);
  return core;
}

const bytes = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, "base64"));

describe("daemon snapshot → renderer engine (P9)", () => {
  it("this engine reads the container version the fixture was written in", async () => {
    const core = await createCore();
    expect(core.snapshotFormatVersion()).toBe(fixture.formatVersion);
  });

  for (const scenario of fixture.scenarios) {
    it(`continues identically after importing: ${scenario.name}`, async () => {
      const a = bytes(scenario.a);
      const b = bytes(scenario.b);

      const continuous = await createCore();
      continuous.write(a);
      continuous.write(b);

      const restored = await createCore();
      expect(restored.importSnapshot(bytes(scenario.snapshot))).toBe(true);
      restored.write(b);

      expect(restored.exportSnapshot(fixture.historyRows)).toEqual(
        continuous.exportSnapshot(fixture.historyRows),
      );
    });
  }

  it("refuses a container it does not read, leaving the terminal reset rather than spliced", async () => {
    const core = await createCore();
    core.write("before the bad import\r\n");
    const bad = bytes(fixture.scenarios[0].snapshot);
    new DataView(bad.buffer, bad.byteOffset).setUint32(4, fixture.formatVersion + 1, true);
    expect(core.importSnapshot(bad)).toBe(false);
    expect(core.exportSnapshot(fixture.historyRows)).not.toBeNull();
  });

  it("refuses an empty state instead of clearing the pane", async () => {
    const core = await createCore();
    expect(core.importSnapshot(new Uint8Array(0))).toBe(false);
  });
});
