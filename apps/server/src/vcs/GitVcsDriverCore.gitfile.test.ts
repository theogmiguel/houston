import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";

// A worktree whose gitdir is gone: Git before 2.56 says "not a git repository",
// Git 2.56 says "gitfile does not point to a valid repository".
const BROKEN_GITFILE_STDERR = [
  "fatal: not a git repository: /tmp/worktree/.git\n",
  "fatal: gitfile does not point to a valid repository: /tmp/worktree/.git\n",
];

const makeDriver = (stderr: string) =>
  makeGitVcsDriverCore().pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.encodeText(Stream.make(stderr)),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      ),
    ),
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-gitfile-test-" })),
  );

describe("a worktree whose gitdir is gone", () => {
  it.effect.each(BROKEN_GITFILE_STDERR)("is not a repository for %j", (stderr) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-git-gitfile-" });
        const driver = yield* makeDriver(stderr);

        const local = yield* driver.statusDetailsLocal(cwd);
        assert.isFalse(local.isRepo);
        const remote = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
        assert.isFalse(remote.isRepo);

        const error = yield* driver
          .execute({ operation: "test.brokenGitfile", cwd, args: ["status"] })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "not_a_repository");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
