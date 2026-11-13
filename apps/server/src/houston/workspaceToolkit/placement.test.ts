// A launch places its threads only for a caller that may change workspaces through the tools.
import { assert, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2LinkOrigin } from "@houston-app/contracts";
import * as Effect from "effect/Effect";

import type { Caller } from "../../mcp/threadAccess.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import { placeLaunched } from "./placement.ts";
import {
  chatThreadsOf,
  layerWorkspaces,
  seedWorkspace,
  WORKSPACE_TEST_ENVIRONMENT,
  workspaceRecord,
} from "./workspaceToolkit.testkit.ts";

const THREAD = ThreadId.make("thread:launched");

/** A caller whose thread a link started with `access`. */
const linkedCaller = (access: OrchestrationV2LinkOrigin["access"]) =>
  ({
    scope: {},
    caller: { linkOrigin: { sessionId: "session:link", label: "Office laptop", access } },
  }) as unknown as Pick<Caller, "scope" | "caller">;

const localCaller = { scope: {}, caller: undefined } as unknown as Pick<Caller, "scope" | "caller">;

it.layer(layerWorkspaces)("placeLaunched and linked callers", (it) => {
  it.effect("a fenced link's launch is not placed and changes no workspace", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const review = yield* seedWorkspace(workspaceRecord("workspace:fenced-target"));
      const before = yield* service.list;

      const existing = yield* placeLaunched({
        caller: linkedCaller("approval-required"),
        environmentId: WORKSPACE_TEST_ENVIRONMENT,
        threadIds: [THREAD],
        target: { workspaceId: review.id },
        replaying: false,
      });
      const created = yield* placeLaunched({
        caller: linkedCaller("approval-required"),
        environmentId: WORKSPACE_TEST_ENVIRONMENT,
        threadIds: [THREAD],
        target: { newWorkspaceName: "Made by a link" },
        replaying: false,
      });

      for (const [placement] of [existing, created]) {
        assert.strictEqual(placement?.placed, false);
        assert.match(
          placement?.placed === false ? placement.error : "",
          /Office laptop through a linked environment.*cannot change this environment's workspaces/,
        );
      }
      const after = yield* service.list;
      assert.deepStrictEqual(
        after.map((workspace) => [workspace.id, workspace.revision, chatThreadsOf(workspace)]),
        before.map((workspace) => [workspace.id, workspace.revision, chatThreadsOf(workspace)]),
      );
    }),
  );

  it.effect("a full-access link and a local caller place their launches", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const target = yield* seedWorkspace(workspaceRecord("workspace:open-target"));
      const other = ThreadId.make("thread:launched-locally");

      const [linked] = yield* placeLaunched({
        caller: linkedCaller("full-access"),
        environmentId: WORKSPACE_TEST_ENVIRONMENT,
        threadIds: [THREAD],
        target: { workspaceId: target.id },
        replaying: false,
      });
      const [local] = yield* placeLaunched({
        caller: localCaller,
        environmentId: WORKSPACE_TEST_ENVIRONMENT,
        threadIds: [other],
        target: { workspaceId: target.id },
        replaying: false,
      });

      assert.deepStrictEqual(linked, { placed: true, workspaceId: target.id });
      assert.deepStrictEqual(local, { placed: true, workspaceId: target.id });
      const stored = yield* service.get(target.id);
      assert.deepStrictEqual(chatThreadsOf(stored), [THREAD, other]);
    }),
  );
});
