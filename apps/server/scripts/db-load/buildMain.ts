import * as Effect from "effect/Effect";

import { buildDatabase, type DatabaseManifest } from "./build.ts";
import { readManifest, scaleDir } from "./paths.ts";

/** Builds (or reuses) the database of each scale. */
export async function ensureDatabases(input: {
  readonly dataDir: string;
  readonly scales: ReadonlyArray<number>;
  readonly seed: number;
  readonly rebuild: boolean;
  readonly log: (line: string) => void;
}): Promise<Array<DatabaseManifest>> {
  const manifests: Array<DatabaseManifest> = [];
  for (const scale of input.scales) {
    const cached = input.rebuild ? undefined : readManifest(input.dataDir, scale, input.seed);
    if (cached !== undefined) {
      input.log(`${scale}x: reusing ${cached.dbPath} (${cached.totalRows} rows)`);
      manifests.push(cached);
      continue;
    }
    input.log(`${scale}x: building`);
    const manifest = await Effect.runPromise(
      buildDatabase({
        dir: scaleDir(input.dataDir, scale),
        scale,
        seed: input.seed,
        log: (line) => input.log(`${scale}x: ${line}`),
      }),
    );
    input.log(
      `${scale}x: built ${manifest.totalRows} rows, ${(manifest.fileBytes / 1e6).toFixed(0)} MB in ${manifest.buildSeconds.toFixed(0)} s`,
    );
    manifests.push(manifest);
  }
  return manifests;
}
