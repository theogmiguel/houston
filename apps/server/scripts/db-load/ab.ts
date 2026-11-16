// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a host-side harness that copies databases and spawns measuring processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DatabaseManifest } from "./build.ts";
import { scaleDir } from "./paths.ts";
import type { ScaleResult, ScaleResults } from "./run.ts";
import { summarize } from "./stats.ts";

export interface AbSide {
  readonly name: string;
  /** Repository root of the checkout whose server code is measured. */
  readonly root: string;
}

/** Concatenates one side's blocks for a scale: every sample, the last block's plans and memory. */
export function mergeBlocks(blocks: ReadonlyArray<ScaleResults>): ScaleResults {
  const names = [...new Set(blocks.flatMap((block) => Object.keys(block)))];
  return Object.fromEntries(
    names.map((name) => {
      const parts = blocks
        .map((block) => block[name])
        .filter((part): part is ScaleResult => part !== undefined);
      const last = parts.at(-1)!;
      const samples = parts.flatMap((part) => part.samples);
      const error = parts.find((part) => part.error !== undefined)?.error;
      return [
        name,
        {
          ...last,
          samples,
          summary: samples.length > 0 ? summarize(samples) : null,
          ...(error === undefined ? {} : { error }),
        } satisfies ScaleResult,
      ];
    }),
  );
}

/** ABBA order: block 0 runs A then B, block 1 B then A, and so on. */
export function blockOrder<T>(a: T, b: T, block: number): readonly [T, T] {
  return block % 2 === 0 ? [a, b] : [b, a];
}

/** A side's copy is reused only while it came from the same build of the source database. */
export function copyIsCurrent(manifestPath: string, source: DatabaseManifest): boolean {
  if (!NodeFS.existsSync(manifestPath)) return false;
  const copy = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Partial<DatabaseManifest>;
  return (
    copy.generatorVersion === source.generatorVersion &&
    copy.seed === source.seed &&
    copy.buildSeconds === source.buildSeconds &&
    copy.totalRows === source.totalRows
  );
}

/** Each side gets its own database copies, so one side's migrations never reach the other's data. */
export function copyDatabasesFor(
  side: AbSide,
  dataDir: string,
  manifests: ReadonlyArray<DatabaseManifest>,
  log: (line: string) => void,
): string {
  const sideDir = NodePath.join(dataDir, `ab-${side.name}`);
  for (const manifest of manifests) {
    const target = scaleDir(sideDir, manifest.scale);
    const manifestPath = NodePath.join(target, "manifest.json");
    if (copyIsCurrent(manifestPath, manifest)) continue;
    log(`${side.name}: copying ${manifest.scale}x database`);
    NodeFS.mkdirSync(target, { recursive: true });
    const dbPath = NodePath.join(target, "state.sqlite");
    NodeFS.copyFileSync(manifest.dbPath, dbPath);
    NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dbPath }, null, 1));
  }
  return sideDir;
}

export function measureBlock(input: {
  readonly side: AbSide;
  readonly sideDataDir: string;
  readonly scale: number;
  readonly out: string;
  readonly heapMb: string;
  readonly args: ReadonlyArray<string>;
}): ScaleResults {
  const serverDir = NodePath.join(input.side.root, "apps", "server");
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${input.heapMb}`,
      "--expose-gc",
      NodePath.join(serverDir, "scripts", "db-load", "main.ts"),
      "measure",
      "--scale",
      String(input.scale),
      "--data-dir",
      input.sideDataDir,
      "--out",
      input.out,
      ...input.args,
    ],
    { cwd: serverDir, stdio: "inherit" },
  );
  if (child.status !== 0) {
    throw new Error(
      `Measuring ${input.side.name} at ${input.scale}x in ${input.side.root} exited with status ${child.status} (signal ${child.signal}).`,
    );
  }
  return JSON.parse(
    NodeFS.readFileSync(NodePath.join(input.out, `scale-${input.scale}x.json`), "utf8"),
  ) as ScaleResults;
}
