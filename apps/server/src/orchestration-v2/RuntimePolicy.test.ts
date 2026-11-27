import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@houston-app/provider-core/server/driver";
import * as McpProviderSessions from "@houston-app/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import { readProviderReplayTranscript } from "@houston-app/provider-testing/replayTranscript";
import {
  HoustonBotThreadLookupError,
  HoustonBotThreads,
  type BotThreadPolicy,
} from "../houston/bots/botThreads.ts";
import { policyFor } from "../houston/bots/kinds.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { AcpRegistryOrchestratorReplayHarness } from "./Adapters/AcpRegistryAdapterV2.testkit.ts";
import { makeAntigravityAcpAdapterFlavor } from "./Adapters/AntigravityAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "./Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "./Adapters/CursorAdapterV2.testkit.ts";
import { FxOrchestratorReplayHarness } from "./Adapters/FxAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "./Adapters/GrokAdapterV2.testkit.ts";
import { KiroOrchestratorReplayHarness } from "./Adapters/KiroAdapterV2.testkit.ts";
import { MuseOrchestratorReplayHarness } from "./Adapters/MuseAdapterV2.testkit.ts";
import { OpenCode2OrchestratorReplayHarness } from "./Adapters/OpenCode2AdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "./Adapters/OpenCodeAdapterV2.testkit.ts";
import { PiOrchestratorReplayHarness } from "./Adapters/PiAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "./testkit/ProviderReplayHarness.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
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
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});

const claudeInstanceId = ProviderInstanceId.make("claude");
const claudeLimitedInstanceId = ProviderInstanceId.make("claude-without-auto");
supportedRuntimeModesByInstance.set(claudeLimitedInstanceId, ["approval-required", "full-access"]);

const adapterWith = (
  instanceId: ProviderInstanceId,
  capabilities: OrchestrationV2ProviderCapabilities,
) =>
  ({
    instanceId,
    driver: instanceId,
    getCapabilities: () => Effect.succeed(capabilities),
  }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const { houstonBotRuns: _claudeKinds, ...undeclared } = ClaudeProviderCapabilitiesV2.runtimePolicy;

const botPolicy = (kind: "asked" | "unattended", runtimeMode?: RuntimeMode): BotThreadPolicy => {
  const stored = policyFor({
    kind,
    bot: {
      askedMode: "approval-required",
      unattendedFullAccess: runtimeMode === "full-access",
      maxMinutes: 20,
    },
  });
  return {
    ...(stored.runtimeMode === undefined ? {} : { runtimeMode: stored.runtimeMode }),
    provider: {
      botName: "Digest writer",
      kind,
      child: false,
      refusedTools: stored.refusedTools,
      rules: stored.rules,
      neverAsk: stored.neverAsk,
    },
  };
};

const replayFixture = (path: string) =>
  readProviderReplayTranscript(new URL(`./testkit/fixtures/${path}`, import.meta.url)).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** What an adapter of the harness's family declares, read from the adapter itself. */
const capabilitiesOf = <Transcript extends ProviderReplayTranscript, E>(
  harness: OrchestratorV2ProviderReplayHarness<Transcript, E>,
  file: string,
) =>
  Effect.gen(function* () {
    const transcript = yield* harness.decodeTranscript({
      ...(yield* replayFixture(file)),
      entries: [],
    });
    return yield* Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const [instanceId] = yield* registry.list();
      return yield* (yield* registry.get(instanceId!)).getCapabilities();
    }).pipe(
      Effect.provide(
        harness
          .makeProviderAdapterRegistryLayer(transcript)
          .pipe(Layer.provide(McpProviderSessions.layer)),
      ),
    );
  }).pipe(Effect.scoped, Effect.orDie);

/** Each adapter of every driver family, as [driver kind, name, capabilities]. */
const familyCapabilities = Effect.all([
  Effect.map(
    capabilitiesOf(ClaudeOrchestratorReplayHarness, "simple/claude_transcript.ndjson"),
    (capabilities) => ["claudeAgent", "Claude", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(CodexOrchestratorReplayHarness, "simple/codex_transcript.ndjson"),
    (capabilities) => ["codex", "Codex", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(OpenCodeOrchestratorReplayHarness, "simple/opencode_transcript.ndjson"),
    (capabilities) => ["opencode", "OpenCode 1", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(
      OpenCode2OrchestratorReplayHarness,
      "opencode2_simple/opencode_transcript.ndjson",
    ),
    (capabilities) => ["opencode", "OpenCode 2", capabilities] as const,
  ),
  Effect.succeed([
    "antigravity",
    "Antigravity",
    makeAntigravityAcpAdapterFlavor({} as never).capabilities,
  ] as const),
  Effect.map(
    capabilitiesOf(AcpRegistryOrchestratorReplayHarness, "simple/registry_transcript.ndjson"),
    (capabilities) => ["acpRegistry", "ACP registry", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(CursorOrchestratorReplayHarness, "simple/cursor_transcript.ndjson"),
    (capabilities) => ["cursor", "Cursor", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(GrokOrchestratorReplayHarness, "simple/grok_transcript.ndjson"),
    (capabilities) => ["grok", "Grok", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(FxOrchestratorReplayHarness, "simple/fx_transcript.ndjson"),
    (capabilities) => ["fx", "Fx", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(KiroOrchestratorReplayHarness, "simple/kiro_transcript.ndjson"),
    (capabilities) => ["kiro", "Kiro", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(MuseOrchestratorReplayHarness, "simple/muse_transcript.ndjson"),
    (capabilities) => ["muse", "Muse", capabilities] as const,
  ),
  Effect.map(
    capabilitiesOf(PiOrchestratorReplayHarness, "simple/pi_transcript.ndjson"),
    (capabilities) => ["pi", "Pi", capabilities] as const,
  ),
]);

/** The bot layer over the project-store policy, with the given thread's bot policy. */
const layerBots = (
  found: BotThreadPolicy | undefined | "fails",
  managedPolicy?: ManagedPolicySummary,
  moreAdapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]> = [],
) =>
  RuntimePolicy.layerBotThreads.pipe(
    Layer.provide(layerWithPolicy(managedPolicy)),
    Layer.provide(
      ProviderAdapterRegistry.layerFromAdapters([
        adapterWith(claudeInstanceId, ClaudeProviderCapabilitiesV2),
        adapterWith(claudeLimitedInstanceId, ClaudeProviderCapabilitiesV2),
        adapterWith(providerInstanceId, CodexProviderCapabilitiesV2),
        adapterWith(grokInstanceId, {
          ...ClaudeProviderCapabilitiesV2,
          runtimePolicy: undeclared,
        }),
        ...moreAdapters,
      ]),
    ),
    Layer.provide(
      Layer.succeed(HoustonBotThreads, {
        policyOf: (thread) =>
          found === "fails"
            ? Effect.fail(new HoustonBotThreadLookupError({ threadId: thread.id }))
            : Effect.succeed(found),
      }),
    ),
  );

const resolveWith = (
  layer: ReturnType<typeof layerBots>,
  input: {
    readonly runtimeMode: RuntimeMode;
    readonly instanceId?: ProviderInstanceId;
    readonly interactionMode?: OrchestrationV2AppThread["interactionMode"];
  },
) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    return yield* policy.resolve({
      thread: {
        ...makeThread({ now, worktreePath: "/work", runtimeMode: input.runtimeMode }),
        interactionMode: input.interactionMode ?? "default",
      },
      modelSelection: { instanceId: input.instanceId ?? claudeInstanceId, model: "opus" },
    });
  }).pipe(Effect.provide(layer));

describe("bot threads", () => {
  it.effect("an unattended bot run runs in its own mode, in the default interaction", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(layerBots(botPolicy("unattended")), {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.equal(resolved.runtimeMode, "auto");
      assert.equal(resolved.interactionMode, "default");
      assert.deepInclude(resolved.houstonBot, { kind: "unattended", neverAsk: true });
    }),
  );

  it.effect("the effective mode is what the provider's supported modes see", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(layerBots(botPolicy("unattended")), {
        runtimeMode: "full-access",
        instanceId: claudeLimitedInstanceId,
      });
      assert.equal(resolved.runtimeMode, "approval-required");
    }),
  );

  it.effect("full access under a ceiling of Auto is refused whatever the thread's mode says", () =>
    Effect.gen(function* () {
      const ceiling: ManagedPolicySummary = {
        organization: "Example Corp",
        lockedSettings: [],
        limits: { maxRuntimeMode: "auto" },
      };
      const refused = yield* resolveWith(
        layerBots(botPolicy("unattended", "full-access"), ceiling),
        {
          runtimeMode: "approval-required",
        },
      ).pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      // The thread's own full access is not what runs, so the ceiling does not refuse it.
      const allowed = yield* resolveWith(layerBots(botPolicy("unattended"), ceiling), {
        runtimeMode: "full-access",
      });
      assert.equal(allowed.runtimeMode, "auto");
    }),
  );

  it.effect("an asked bot run keeps the thread's own modes", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith(layerBots(botPolicy("asked")), {
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      });
      assert.equal(resolved.runtimeMode, "auto-accept-edits");
      assert.equal(resolved.interactionMode, "plan");
      assert.deepInclude(resolved.houstonBot, { kind: "asked", neverAsk: false });
    }),
  );

  it.effect("a driver that does not declare the kind is refused by name", () =>
    Effect.gen(function* () {
      for (const instanceId of [providerInstanceId, grokInstanceId]) {
        for (const kind of ["asked", "unattended"] as const) {
          const refused = yield* resolveWith(layerBots(botPolicy(kind)), {
            runtimeMode: "auto",
            instanceId,
          }).pipe(Effect.flip);
          assert.equal(refused._tag, "RuntimePolicyResolveError");
          assert.include(refused.message, "Digest writer");
          assert.include(refused.message, instanceId);
          assert.include(refused.message, kind);
        }
      }
    }),
  );

  it.effect("of every registered driver family, only Claude applies a bot run's rules", () =>
    Effect.gen(function* () {
      const families = yield* familyCapabilities;
      assert.sameMembers(
        [...new Set(families.map(([driver]): string => driver))],
        BUILT_IN_DRIVERS.map((driver): string => driver.driverKind),
      );
      for (const [index, [driver, name, capabilities]] of families.entries()) {
        if (driver === "claudeAgent") {
          assert.deepEqual(capabilities.runtimePolicy.houstonBotRuns, ["asked", "unattended"]);
          continue;
        }
        assert.isFalse("houstonBotRuns" in capabilities.runtimePolicy, name);
        const instanceId = ProviderInstanceId.make(`family-${index}`);
        for (const kind of ["asked", "unattended"] as const) {
          const refused = yield* resolveWith(
            layerBots(botPolicy(kind), undefined, [adapterWith(instanceId, capabilities)]),
            { runtimeMode: "auto", instanceId },
          ).pipe(Effect.flip);
          assert.equal(refused._tag, "RuntimePolicyResolveError", name);
          assert.include(refused.message, "Digest writer", name);
          assert.include(refused.message, kind, name);
        }
      }
    }),
  );

  it.effect("an ordinary thread resolves exactly as it did, with no bot rules", () =>
    Effect.gen(function* () {
      const base = yield* Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        return yield* policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode: "auto" }),
          modelSelection: { instanceId: claudeInstanceId, model: "opus" },
        });
      }).pipe(Effect.provide(layerWithPolicy()));
      const resolved = yield* resolveWith(layerBots(undefined), { runtimeMode: "auto" });
      assert.deepEqual(resolved, base);
      assert.notProperty(resolved, "houstonBot");
    }),
  );

  it.effect("a failed lookup fails the turn by name", () =>
    Effect.gen(function* () {
      const refused = yield* resolveWith(layerBots("fails"), { runtimeMode: "auto" }).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "RuntimePolicyResolveError");
      assert.equal(refused.message, "Houston could not read whether this thread is a bot's.");
    }),
  );
});
