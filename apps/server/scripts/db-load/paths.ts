// @effect-diagnostics nodeBuiltinImport:off - host-side benchmark paths under the OS temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { GENERATOR_VERSION, type DatabaseManifest } from "./build.ts";

/** Generated databases live under the OS temp directory, never in a channel's state. */
export const DEFAULT_DATA_DIR = NodePath.join(NodeOS.tmpdir(), "houston-db-load");

export const scaleDir = (dataDir: string, scale: number) => NodePath.join(dataDir, `${scale}x`);

export function readManifest(
  dataDir: string,
  scale: number,
  seed: number,
  versions: ReadonlyArray<number> = [GENERATOR_VERSION],
): DatabaseManifest | undefined {
  const path = NodePath.join(scaleDir(dataDir, scale), "manifest.json");
  if (!NodeFS.existsSync(path)) return undefined;
  const manifest = JSON.parse(NodeFS.readFileSync(path, "utf8")) as DatabaseManifest;
  if (!versions.includes(manifest.generatorVersion) || manifest.seed !== seed) return undefined;
  if (!NodeFS.existsSync(manifest.dbPath)) return undefined;
  return manifest;
}
