import * as HostProcess from "@houston-app/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { layerPlatformServices } from "../server.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("server spawner", () => {
  // A file as cwd tells the two apart: libuv fails the spawn on chdir, env exits 125.
  it.live("the server's platform services start processes through env -C", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const file = yield* fileSystem.makeTempFileScoped();
      const exit = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.exitCode(ChildProcess.make("true", [], { cwd: file })),
      ).pipe(Effect.result);
      expect(exit).toMatchObject({ _tag: "Success", success: 125 });
    }).pipe(Effect.scoped, Effect.provide(layerPlatformServices)),
  );
});
