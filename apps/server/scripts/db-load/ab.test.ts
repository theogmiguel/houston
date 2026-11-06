// @effect-diagnostics nodeBuiltinImport:off - the test writes a manifest to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { blockOrder, copyIsCurrent, mergeBlocks } from "./ab.ts";
import type { DatabaseManifest } from "./build.ts";
import type { ScaleResult } from "./run.ts";

const part = (samples: ReadonlyArray<number>, extra: Partial<ScaleResult> = {}): ScaleResult => ({
  scale: 10,
  size: 1_000,
  samples,
  summary: null,
  statements: [],
  ...extra,
});

describe("db-load A/B blocks", () => {
  it("alternates which side goes first", () => {
    expect([0, 1, 2, 3].map((block) => blockOrder("a", "b", block))).toEqual([
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  it("merges every block's samples and keeps the last block's plans and any error", () => {
    const merged = mergeBlocks([
      { q: part([1, 2]), only: part([5]) },
      {
        q: part([3], { statements: [{ sql: "SELECT 1", executions: 1, plan: [], fullScans: [] }] }),
      },
      { q: part([4], { error: "boom" }) },
    ]);
    expect(merged.q!.samples).toEqual([1, 2, 3, 4]);
    expect(merged.q!.summary!.p50).toBe(2.5);
    expect(merged.q!.error).toBe("boom");
    expect(merged.only!.samples).toEqual([5]);
  });

  it("reuses a side's copy only while it matches the source build", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "db-load-ab-"));
    try {
      const manifestPath = NodePath.join(dir, "manifest.json");
      const source = {
        generatorVersion: 5,
        seed: 7,
        buildSeconds: 90,
        totalRows: 1_000,
      } as DatabaseManifest;
      expect(copyIsCurrent(manifestPath, source)).toBe(false);
      NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...source, dbPath: "copy" }));
      expect(copyIsCurrent(manifestPath, source)).toBe(true);
      expect(copyIsCurrent(manifestPath, { ...source, generatorVersion: 6 })).toBe(false);
      expect(copyIsCurrent(manifestPath, { ...source, buildSeconds: 91 })).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
