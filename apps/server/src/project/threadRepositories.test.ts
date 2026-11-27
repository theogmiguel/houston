import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import {
  ThreadProjectNotFoundError,
  ThreadRepositoryResolver,
  repositoriesOf,
} from "./threadRepositories.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const project = Effect.succeedSome({ workspaceRoot: "/work/app" });

it.effect("a thread in the project folder works in the project root", () =>
  Effect.gen(function* () {
    const repositories = yield* repositoriesOf(
      { id: threadId, projectId, worktreePath: null, branch: "main" },
      project,
    );
    assert.deepStrictEqual(repositories, [
      { key: ".", root: "/work/app", branch: "main", baseBranch: null },
    ]);
  }),
);

it.effect("a thread with a worktree works in the worktree without reading the project", () =>
  Effect.gen(function* () {
    const repositories = yield* repositoriesOf(
      { id: threadId, projectId, worktreePath: "/work/wt/feature", branch: "feature" },
      Effect.die("the project must not be read"),
    );
    assert.deepStrictEqual(repositories, [
      { key: ".", root: "/work/wt/feature", branch: "feature", baseBranch: null },
    ]);
  }),
);

it.effect("a thread in a multi-repository project works in every repository", () =>
  Effect.gen(function* () {
    const repositories = yield* repositoriesOf(
      { id: threadId, projectId, worktreePath: null, branch: "main" },
      project,
    ).pipe(
      Effect.provideService(ThreadRepositoryResolver, {
        list: () =>
          Effect.succeed([
            { key: ".", root: "/work/app", branch: null, baseBranch: null },
            { key: "sibling", root: "/work/app/sibling", branch: null, baseBranch: null },
            { key: "../tracked", root: "/work/tracked", branch: null, baseBranch: null },
          ]),
      }),
    );
    assert.deepStrictEqual(repositories, [
      { key: ".", root: "/work/app", branch: "main", baseBranch: null },
      { key: "sibling", root: "/work/app/sibling", branch: null, baseBranch: null },
      { key: "../tracked", root: "/work/tracked", branch: null, baseBranch: null },
    ]);
  }),
);

it.effect(
  "a thread whose project is gone fails naming the thread, project and expected shape",
  () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        repositoriesOf(
          { id: threadId, projectId, worktreePath: null, branch: null },
          Effect.succeedNone,
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();
      assert.isTrue(Option.isSome(error));
      const failure = Option.getOrThrow(error);
      assert.instanceOf(failure, ThreadProjectNotFoundError);
      assert.include(failure.message, "thread-1");
      assert.include(failure.message, "project-1");
      assert.include(failure.message, "worktreePath");
    }),
);
