// The side-thread rules that need no provider: the review prompt, the forced read-only policy
// and the refusal text.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ClaudeProviderCapabilitiesV2,
  claudeRuntimeQueryPolicyForRuntimePolicy,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  buildCodexTurnStartParams,
  CodexProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CommandPolicyCapabilityUnsupportedError } from "../orchestration-v2/CommandPolicy.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { layerNoReadOnlyThreads, mayHoldT3Tools, reviewPrompt } from "./sideThreads.ts";
import {
  makeHarness,
  runWith,
  withoutReadOnlyRun,
  withReadOnlyRun,
} from "./sideThreads.testkit.ts";

const NO_DIFF = "No diff is recorded for this turn.";
const marker = (shown: number, total: number) =>
  `[truncated: showing ${shown} of ${total} characters]`;

describe("the review prompt", () => {
  it("the review prompt is bounded and ordered", () => {
    const request = "Please fix the tokenizer.";
    const report = "I rewrote `split` to keep empty tokens.";
    const diff = "diff --git a/src/parse.ts b/src/parse.ts\n+keep empty tokens\n";
    const prompt = reviewPrompt({ request, report, diff });
    const at = [prompt.indexOf(request), prompt.indexOf(report), prompt.indexOf(diff)];
    assert.isTrue(
      at.every((index) => index >= 0),
      JSON.stringify(at),
    );
    assert.isBelow(at[0]!, at[1]!);
    assert.isBelow(at[1]!, at[2]!);
    assert.include(prompt, "Do not change any files");
    assert.notInclude(prompt, "[truncated");

    // 60 000 characters of diff fit whole.
    const exact = "d".repeat(60_000);
    const whole = reviewPrompt({ request, report, diff: exact });
    assert.include(whole, exact);
    assert.notInclude(whole, "[truncated");

    // 60 001 characters are cut at 60 000 and say so.
    const over = `${"d".repeat(60_000)}X`;
    const cut = reviewPrompt({ request, report, diff: over });
    assert.include(cut, `${"d".repeat(60_000)}\n${marker(60_000, 60_001)}`);
    assert.notInclude(cut, "dX");

    // No checkpoint: the diff is replaced by a named placeholder.
    const none = reviewPrompt({ request, report, diff: null });
    assert.include(none, NO_DIFF);
    assert.isBelow(none.indexOf(report), none.indexOf(NO_DIFF));

    // The request and the report have bounds of their own.
    const longRequest = `${"r".repeat(4_000)}Y`;
    const longReport = `${"p".repeat(8_000)}Z`;
    const bounded = reviewPrompt({ request: longRequest, report: longReport, diff });
    assert.include(bounded, `${"r".repeat(4_000)}\n${marker(4_000, 4_001)}`);
    assert.include(bounded, `${"p".repeat(8_000)}\n${marker(8_000, 8_001)}`);
    assert.notInclude(bounded, "rY");
    assert.notInclude(bounded, "pZ");
    assert.include(
      reviewPrompt({ request: "r".repeat(4_000), report: "p".repeat(8_000), diff }),
      "r".repeat(4_000),
    );
    assert.notInclude(
      reviewPrompt({ request: "r".repeat(4_000), report: "p".repeat(8_000), diff }),
      "[truncated",
    );
  });
});

const READ_ONLY = {
  interactionMode: "default",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
} as const;

const projectId = ProjectId.make("project:side-policy");
const codex = ProviderInstanceId.make("codex");
const antigravity = ProviderInstanceId.make("antigravity");

const makeThread = (input: {
  readonly now: DateTime.Utc;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default" | "plan";
  readonly side: boolean;
  readonly worktreePath: string | null;
  readonly instanceId?: ProviderInstanceId;
}): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(input.side ? "thread:side" : "thread:plain");
  const instanceId = input.instanceId ?? codex;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Policy",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test-model" },
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    ...(input.side
      ? {
          side: {
            kind: "secondOpinion" as const,
            sourceThreadId: ThreadId.make("thread:source"),
            sourceRunId: RunId.make("run:source:1"),
          },
        }
      : {}),
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const adapterWith = (
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
) =>
  ({
    instanceId,
    driver: instanceId,
    getCapabilities: () => Effect.succeed(capabilities),
  }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
  adapterWith(codex, withReadOnlyRun(CodexProviderCapabilitiesV2, "sandbox")),
  adapterWith(antigravity, withoutReadOnlyRun(CodexProviderCapabilitiesV2)),
]);

const layerProjectStoreBase = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () =>
        Effect.succeed({
          snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
        } as ProviderInstance),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/project-root",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: "2026-10-30T00:00:00.000Z",
          updatedAt: "2026-10-30T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

// The two assemblies that resolve a turn's policy: the replay harness and the server runtime.
const assemblies = [
  ["layer", RuntimePolicy.layer],
  ["layerFromProjectStore", layerProjectStoreBase],
] as const;

const resolveWith = (
  base: Layer.Layer<RuntimePolicy.RuntimePolicyV2>,
  thread: OrchestrationV2AppThread,
  modelSelection: ModelSelection = thread.modelSelection,
) =>
  Effect.gen(function* () {
    const forced = yield* Effect.gen(function* () {
      const resolver = yield* RuntimePolicy.RuntimePolicyV2;
      return yield* resolver.resolve({ thread, modelSelection });
    }).pipe(
      Effect.provide(
        RuntimePolicy.layerReadOnlySideThreads.pipe(
          Layer.provide(base),
          Layer.provide(layerRegistry),
          Layer.provide(layerNoReadOnlyThreads),
        ),
      ),
    );
    const upstream = yield* Effect.gen(function* () {
      const resolver = yield* RuntimePolicy.RuntimePolicyV2;
      return yield* resolver.resolve({ thread, modelSelection });
    }).pipe(Effect.provide(base));
    return { forced, upstream };
  });

describe("the side-thread policy", () => {
  it.effect("a side thread always resolves read-only", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const [name, base] of assemblies) {
        for (const worktreePath of ["/work/tree", null]) {
          // Stored full-access and plan: plan would open Claude in plan mode with a write path.
          const side = makeThread({
            now,
            runtimeMode: "full-access",
            interactionMode: "plan",
            side: true,
            worktreePath,
          });
          const { forced, upstream } = yield* resolveWith(base, side);
          assert.deepInclude(forced, READ_ONLY, name);
          assert.equal(forced.runtimeMode, "full-access", name);
          assert.equal(forced.cwd, upstream.cwd, name);
          if (name === "layerFromProjectStore" && worktreePath === null) {
            assert.equal(forced.cwd, "/project-root");
          }

          // A thread without side resolves exactly as upstream.
          const plain = makeThread({
            now,
            runtimeMode: "full-access",
            interactionMode: "plan",
            side: false,
            worktreePath,
          });
          const resolved = yield* resolveWith(base, plain);
          assert.deepEqual(resolved.forced, resolved.upstream, name);
          assert.equal(resolved.forced.interactionMode, "plan", name);
          assert.isUndefined(resolved.forced.sandboxPolicy, name);
        }
      }
    }),
  );

  it.effect("a side thread always resolves read-only after its mode changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("policy-mode-set");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const source = yield* context.createThread({
              threadId: "source",
              driver: "codex",
              runtimeMode: "approval-required",
            });
            yield* context.turn(source, "message:source:1", "first");
            yield* context.dispatch({
              type: "houston.aside.start",
              commandId: CommandId.make("aside"),
              sourceThreadId: source,
              asideThreadId: ThreadId.make("aside"),
              messageId: "message:aside" as never,
              text: "Why?",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            });
            yield* context.settle;
            yield* context.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("mode"),
              threadId: ThreadId.make("aside"),
              runtimeMode: "full-access",
            });
            yield* context.turn(ThreadId.make("aside"), "message:aside:2", "And now?");
            const turn = harness.log.started.find(
              (candidate) => candidate.input.message.messageId === "message:aside:2",
            );
            assert.isDefined(turn);
            assert.equal(turn.input.runtimePolicy.runtimeMode, "full-access");
            assert.deepInclude(turn.input.runtimePolicy, READ_ONLY);
          }),
        );
      }),
    ),
  );
});

const claude = ProviderInstanceId.make("claudeAgent");

// The production policy assembly over providers that report their real capabilities.
const layerServerRuntimePolicy = RuntimeLayer.layerRuntimePolicyProvided.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId: ProviderInstanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: instanceId,
          orchestrationAdapter: adapterWith(
            instanceId,
            instanceId === claude ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
          ),
          snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
        } as unknown as ProviderInstance),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerNoReadOnlyThreads),
);

describe("the server's side-thread policy", () => {
  it.effect("a side thread always resolves read-only through the server runtime", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resolver = yield* RuntimePolicy.RuntimePolicyV2;
      for (const instanceId of [claude, codex]) {
        const thread = makeThread({
          now,
          runtimeMode: "full-access",
          interactionMode: instanceId === claude ? "plan" : "default",
          side: true,
          worktreePath: "/work/tree",
          instanceId,
        });
        const policy = yield* resolver.resolve({ thread, modelSelection: thread.modelSelection });
        assert.deepInclude(policy, READ_ONLY, instanceId);
        if (instanceId === claude) {
          const query = claudeRuntimeQueryPolicyForRuntimePolicy(policy);
          assert.equal(query.permissionMode, "dontAsk");
          assert.isUndefined(query.allowDangerouslySkipPermissions);
        } else {
          const start = yield* buildCodexTurnStartParams({
            nativeThreadId: "native:side",
            codexInput: [],
            runtimePolicy: policy,
            modelSelection: thread.modelSelection,
          });
          assert.deepEqual(start.sandboxPolicy, {
            type: "readOnly",
            networkAccess: false,
          } as never);
          assert.equal(start.approvalPolicy, "never");
        }
      }
    }).pipe(Effect.provide(layerServerRuntimePolicy)),
  );
});

describe("the T3 tool guard", () => {
  it.effect("a thread whose read fails gets no T3 tools", () =>
    Effect.gen(function* () {
      const side = { kind: "aside", sourceThreadId: "source", sourceRunId: "run:1" } as never;
      assert.isTrue(yield* mayHoldT3Tools(Effect.succeed({})));
      assert.isFalse(yield* mayHoldT3Tools(Effect.succeed({ side })));
      assert.isFalse(yield* mayHoldT3Tools(Effect.fail("projection read failed")));
    }),
  );
});

describe("the refusal", () => {
  it("the read-only refusal names the provider", () => {
    const refusal = (instanceId: string) =>
      userFacingDispatchErrorMessage(
        new CommandPolicyCapabilityUnsupportedError({
          commandId: CommandId.make("command:aside"),
          threadId: ThreadId.make("thread:source"),
          providerInstanceId: ProviderInstanceId.make(instanceId),
          capability: "read_only_run",
          detail: "providerInstanceId cannot run read-only",
        }),
      );
    assert.equal(
      refusal("antigravity"),
      "Antigravity cannot run read-only, so it cannot hold an aside or give a second opinion.",
    );
    assert.equal(
      refusal("acpRegistry"),
      "ACP Registry cannot run read-only, so it cannot hold an aside or give a second opinion.",
    );
    assert.equal(
      refusal("cursor"),
      "Cursor cannot run read-only, so it cannot hold an aside or give a second opinion.",
    );
  });
});
