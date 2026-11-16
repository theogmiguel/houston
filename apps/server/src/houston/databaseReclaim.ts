// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DiskSpaceCheckError extends Schema.TaggedError<DiskSpaceCheckError>()(
  "DiskSpaceCheckError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not check the free disk space where ${this.path} is stored.`;
  }
}

export const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;

/**
 * The free space `requiredBytes` needs where the database is stored, or null when it fits.
 * `bavail` is what an unprivileged process may use, not what a full disk reserves for root.
 */
export const diskShortfall = Effect.fn("houston.databaseReclaim.diskShortfall")(function* (
  databasePath: string,
  requiredBytes: number,
) {
  const path = yield* Path.Path;
  const directory = path.dirname(databasePath);
  const stats = yield* Effect.tryPromise({
    try: () => NodeFSP.statfs(directory),
    catch: (cause) => new DiskSpaceCheckError({ path: directory, cause }),
  });
  const freeBytes = stats.bavail * stats.bsize;
  return freeBytes < requiredBytes ? { neededBytes: requiredBytes, freeBytes } : null;
});
