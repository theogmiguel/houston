import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { git } from "./TaskGit.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("TaskGit", () => {
  // The child enters the folder, so a missing one is named by env, not reported as a missing git.
  it.live("runs git in a folder with spaces, and names a folder that is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const repo = `${root}/a repo`;
      yield* fileSystem.makeDirectory(repo);
      yield* git(repo, ["init", "--quiet"]);
      expect(yield* git(repo, ["rev-parse", "--show-toplevel"])).toBe(repo);

      const error = yield* Effect.flip(git(`${root}/missing`, ["status"]));
      expect(error.detail).toContain(`cannot change directory to '${root}/missing'`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
