// Each family's read-only run, replayed through its own adapter with no policy override on the
// side thread: the policy must come from the side record, or the recorded frames differ.
// Composed fixtures under houston_side_read_only name the recording they change.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { openCodePermissionRules } from "@t3tools/provider-opencode/server";
import { sessionRules } from "@t3tools/provider-opencode/server/v2/adapter";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeAntigravityAcpAdapterFlavor } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { AcpRegistryOrchestratorReplayHarness } from "../orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeObservedReplayHarness,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { CursorOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CursorAdapterV2.testkit.ts";
import { FxOrchestratorReplayHarness } from "../orchestration-v2/Adapters/FxAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../orchestration-v2/Adapters/GrokAdapterV2.testkit.ts";
import { MuseOrchestratorReplayHarness } from "../orchestration-v2/Adapters/MuseAdapterV2.testkit.ts";
import { OpenCode2OrchestratorReplayHarness } from "../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/OpenCodeAdapterV2.testkit.ts";
import { PiOrchestratorReplayHarness } from "../orchestration-v2/Adapters/PiAdapterV2.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { provideDeterministicTestRuntime } from "../orchestration-v2/testkit/DeterministicRuntime.ts";
import { houstonSideReadOnly } from "../orchestration-v2/testkit/fixtures/houston_side_read_only/input.ts";
import { TOOL_CALL_READ_ONLY_PROMPT } from "../orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../orchestration-v2/testkit/OrchestratorScenario.ts";
import {
  layerProviderReplay,
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { makeHarness, runWith, selection } from "./sideThreads.testkit.ts";
import {
  CodexProviderCapabilitiesV2,
  codexThreadRuntimeParams,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

const READ_ONLY_POLICY = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/work",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
} as const;

const fixture = (path: string) =>
  new URL(`../orchestration-v2/testkit/fixtures/${path}`, import.meta.url);

const readFixture = (file: URL) =>
  readProviderReplayTranscript(file).pipe(Effect.provide(NodeServices.layer));

const withRuntimeInstructions = (
  transcript: ProviderReplayTranscript,
  modelSelection: ModelSelection,
  driver: string,
) =>
  materializeReplayTranscriptRuntimeInstructions(transcript, {
    driver: ProviderDriverKind.make(driver),
    model: modelSelection.model,
  });

/** A second-opinion thread as the server stores it, seeded directly so its first turn can carry a recorded prompt. */
const sideThreadRecord = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: input.threadId,
  projectId: ProjectId.make("project:side-families"),
  title: "Second opinion: recorded turn",
  providerInstanceId: input.modelSelection.instanceId,
  modelSelection: input.modelSelection,
  // Stored modes a side thread inherits from a Full access, Plan source.
  runtimeMode: "full-access",
  interactionMode: "plan",
  branch: null,
  worktreePath: input.worktreePath,
  activeProviderThreadId: null,
  lineage: { rootThreadId: input.threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  side: {
    kind: "secondOpinion",
    sourceThreadId: ThreadId.make("thread:recorded-source"),
    sourceRunId: RunId.make("run:recorded-source:1"),
  },
  createdAt: input.now,
  updatedAt: input.now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Seeds a side thread and replays one turn on it through the provider's own adapter. */
const replayOnSideThread = <Transcript extends ProviderReplayTranscript, E>(input: {
  readonly name: string;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, E>;
  readonly transcript: Transcript;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly worktreePath: string;
}) =>
  Effect.gen(function* () {
    const command = {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${input.name}:message`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:${input.name}`),
      text: input.prompt,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    } as const;
    const scenario = {
      name: input.name,
      transcript: input.transcript,
      commands: [command],
      steps: [
        { type: "dispatch" as const, command, await: true },
        { type: "await_thread_idle" as const, threadId: input.threadId },
      ],
      projectionThreadIds: [input.threadId],
    };
    return yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const thread = sideThreadRecord({ ...input, now });
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "thread.created",
            threadId: input.threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: thread,
          } as OrchestrationV2DomainEvent,
        ],
      });
      return yield* runOrchestratorV2Scenario(scenario);
    }).pipe(
      Effect.provide(
        Layer.merge(
          IdAllocator.layer,
          layerProviderReplay(scenario, input.harness, {
            configureMcp: true,
            mcpSessionRegistry: McpSessionRegistryTestkit.layer,
          }),
        ),
      ),
      provideDeterministicTestRuntime,
    );
  });

const workspace = (name: string) => checkpointWorkspace(`side-families-${name}`);

describe("read-only declarations", () => {
  const empty = <T extends ProviderReplayTranscript>(transcript: T): T => ({
    ...transcript,
    entries: [],
  });
  const capabilitiesOf = <Transcript extends ProviderReplayTranscript, E>(
    harness: OrchestratorV2ProviderReplayHarness<Transcript, E>,
    file: string,
  ) =>
    Effect.gen(function* () {
      const transcript = yield* harness.decodeTranscript(empty(yield* readFixture(fixture(file))));
      return yield* Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const [instanceId] = yield* registry.list();
        const adapter = yield* registry.get(instanceId!);
        return yield* adapter.getCapabilities();
      }).pipe(
        Effect.provide(
          harness
            .makeProviderAdapterRegistryLayer(transcript)
            .pipe(Layer.provide(McpProviderSessions.layer)),
        ),
      );
    }).pipe(Effect.scoped, Effect.orDie);

  it.effect("each adapter declares its read-only run", () =>
    Effect.gen(function* () {
      const rows: ReadonlyArray<
        readonly [string, Effect.Effect<OrchestrationV2ProviderCapabilities>, unknown]
      > = [
        [
          "Claude",
          capabilitiesOf(ClaudeOrchestratorReplayHarness, "simple/claude_transcript.ndjson"),
          "permissionMode",
        ],
        [
          "Codex",
          capabilitiesOf(CodexOrchestratorReplayHarness, "simple/codex_transcript.ndjson"),
          "sandbox",
        ],
        [
          "OpenCode 1",
          capabilitiesOf(OpenCodeOrchestratorReplayHarness, "simple/opencode_transcript.ndjson"),
          "permissionRules",
        ],
        [
          "OpenCode 2",
          capabilitiesOf(
            OpenCode2OrchestratorReplayHarness,
            "opencode2_simple/opencode_transcript.ndjson",
          ),
          "permissionRules",
        ],
        [
          "Antigravity",
          Effect.succeed(makeAntigravityAcpAdapterFlavor({} as never).capabilities),
          undefined,
        ],
        [
          "ACP registry",
          capabilitiesOf(AcpRegistryOrchestratorReplayHarness, "simple/registry_transcript.ndjson"),
          undefined,
        ],
        [
          "Cursor",
          capabilitiesOf(CursorOrchestratorReplayHarness, "simple/cursor_transcript.ndjson"),
          undefined,
        ],
        [
          "Grok",
          capabilitiesOf(GrokOrchestratorReplayHarness, "simple/grok_transcript.ndjson"),
          undefined,
        ],
        [
          "Fx",
          capabilitiesOf(FxOrchestratorReplayHarness, "simple/fx_transcript.ndjson"),
          undefined,
        ],
        [
          "Muse",
          capabilitiesOf(MuseOrchestratorReplayHarness, "simple/muse_transcript.ndjson"),
          undefined,
        ],
        [
          "Pi",
          capabilitiesOf(PiOrchestratorReplayHarness, "simple/pi_transcript.ndjson"),
          undefined,
        ],
      ];
      assert.lengthOf(rows, 11);
      for (const [name, capabilities, expected] of rows) {
        const declared = yield* capabilities;
        assert.equal(declared.runtimePolicy.readOnlyRun, expected, name);
        if (expected === undefined) assert.isFalse("readOnlyRun" in declared.runtimePolicy, name);
      }
    }),
  );
});

describe("read-only runs per family", () => {
  it.effect("a Claude side thread opens read-only", () =>
    Effect.gen(function* () {
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
      const raw = yield* readFixture(fixture("tool_call_read_only/claude_transcript.ndjson"));
      const modelSelection = selection("claudeAgent", "claude-sonnet-4-6");
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(raw, modelSelection, "claudeAgent"),
      );
      const { harness, assertComplete } = makeClaudeObservedReplayHarness(transcript, (input) =>
        opened.push(input),
      );
      const cwd = yield* workspace("claude");
      const threadId = ThreadId.make("thread:claude-side");
      const result = yield* replayOnSideThread({
        name: "houston_side_read_only/claude",
        harness,
        transcript,
        threadId,
        modelSelection,
        prompt: TOOL_CALL_READ_ONLY_PROMPT,
        worktreePath: cwd,
      });
      yield* assertComplete;
      assert.equal(result.projections.get(threadId)?.runs[0]?.status, "completed");
      assert.lengthOf(opened, 1);
      const options = opened[0]!.options;
      assert.equal(options.permissionMode, "dontAsk");
      assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
      for (const tool of ["Read", "Glob", "Grep"]) assert.include(options.allowedTools ?? [], tool);
      assert.isUndefined(options.allowDangerouslySkipPermissions);
      assert.isFalse(
        Object.keys(options.mcpServers ?? {}).includes("t3-code"),
        "a side thread's query carries no T3 MCP server",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a Codex aside runs in the read-only sandbox", () =>
    Effect.gen(function* () {
      const cwd = yield* workspace("codex");
      const raw = yield* readFixture(houstonSideReadOnly.codex.transcriptFile);
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(raw, cwd),
      );
      const ids = yield* Effect.gen(function* () {
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const projectId = yield* allocator.allocate.project({ fixtureName: "houston-side-codex" });
        const sourceThreadId = yield* allocator.allocate.thread({
          fixtureName: "houston-side-codex-source",
          projectId,
        });
        return { projectId, sourceThreadId };
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const asideThreadId = ThreadId.make("thread:codex-aside");
      const modelSelection = houstonSideReadOnly.codex.modelSelection;
      const commands = [
        {
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:houston-side-codex:create"),
          threadId: ids.sourceThreadId,
          projectId: ids.projectId,
          title: "Source thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        },
        {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:houston-side-codex:alpha"),
          threadId: ids.sourceThreadId,
          messageId: MessageId.make("message-houston-side-codex-alpha"),
          text: houstonSideReadOnly.codex.sourcePrompt,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        },
        {
          type: "houston.aside.start",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:houston-side-codex:aside"),
          sourceThreadId: ids.sourceThreadId,
          asideThreadId,
          messageId: MessageId.make("message-houston-side-codex-aside"),
          text: houstonSideReadOnly.codex.asidePrompt,
          attachments: [],
        },
      ] as const;
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "houston_side_read_only/codex",
          transcript,
          commands,
          steps: [
            { type: "dispatch", command: commands[0], await: true },
            { type: "advance_clock", duration: "1 millis" },
            { type: "dispatch", command: commands[1], await: true },
            { type: "await_thread_idle", threadId: ids.sourceThreadId },
            { type: "dispatch", command: commands[2], await: true },
            { type: "await_thread_idle", threadId: asideThreadId },
          ],
          projectionThreadIds: [ids.sourceThreadId, asideThreadId],
          // The source's recorded turn ran read-only too; only the source gets the override.
          runtimePolicyOverride: {
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
          runtimePolicyOverrideThreadIds: [ids.sourceThreadId],
        },
        CodexOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const aside = result.projections.get(asideThreadId);
      assert.isDefined(aside);
      assert.equal(aside.thread.side?.kind, "aside");
      assert.equal(aside.runs[0]?.status, "completed");
      assert.equal(aside.contextTransfers[0]?.resolution?.strategy, "native_fork");
      // The replay matched the recorded aside turn/start, whose sandboxPolicy is read-only.
      const asideTurnStart = transcript.entries.findLast(
        (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
      );
      assert.deepEqual(
        (asideTurnStart as { readonly frame: { readonly params: Record<string, unknown> } }).frame
          .params.sandboxPolicy,
        { type: "readOnly", networkAccess: false },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an OpenCode 1 side thread denies every write", () =>
    Effect.gen(function* () {
      const cwd = yield* workspace("opencode");
      const { modelSelection, prompt, threadId } = houstonSideReadOnly.opencode;
      const raw = yield* readFixture(houstonSideReadOnly.opencode.transcriptFile);
      const transcript = yield* OpenCodeOrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(raw, modelSelection, "opencode"),
      );
      const result = yield* replayOnSideThread({
        name: "houston_side_read_only/opencode",
        harness: OpenCodeOrchestratorReplayHarness,
        transcript,
        threadId,
        modelSelection,
        prompt,
        worktreePath: cwd,
      });
      assert.equal(result.projections.get(threadId)?.runs[0]?.status, "completed");

      const recorded = transcript.entries.find(
        (entry) =>
          entry.type === "expect_outbound" &&
          (entry.frame as { readonly type?: string }).type === "session.create",
      ) as { readonly frame: { readonly input: { readonly permission: unknown } } };
      const rules = recorded.frame.input.permission as ReadonlyArray<{
        readonly permission: string;
        readonly pattern: string;
        readonly action: string;
      }>;
      assert.deepEqual(rules, openCodePermissionRules({ ...READ_ONLY_POLICY, cwd }));
      assert.deepInclude(rules, { permission: "*", pattern: "*", action: "deny" });
      for (const permission of [
        "bash",
        "edit",
        "webfetch",
        "websearch",
        "codesearch",
        "doom_loop",
      ]) {
        assert.isFalse(
          rules.some((rule) => rule.permission === permission && rule.action !== "deny"),
          permission,
        );
      }
      assert.isFalse(rules.some((rule) => rule.action === "ask"));
      assert.deepInclude(rules, { permission: "read", pattern: "*", action: "allow" });
      assert.deepInclude(rules, {
        permission: "external_directory",
        pattern: "*",
        action: "allow",
      });
      // A side thread stored in Auto-accept edits is still denied edits.
      assert.isFalse(
        openCodePermissionRules({ ...READ_ONLY_POLICY, runtimeMode: "auto-accept-edits" }).some(
          (rule) => rule.permission === "edit" && rule.action === "allow",
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an OpenCode 2 side thread denies every write", () =>
    Effect.gen(function* () {
      const cwd = yield* workspace("opencode2");
      const { modelSelection, prompt, threadId } = houstonSideReadOnly.opencode2;
      const raw = yield* readFixture(houstonSideReadOnly.opencode2.transcriptFile);
      const transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(raw, modelSelection, "opencode"),
      );
      const result = yield* replayOnSideThread({
        name: "houston_side_read_only/opencode2",
        harness: OpenCode2OrchestratorReplayHarness,
        transcript,
        threadId,
        modelSelection,
        prompt,
        worktreePath: cwd,
      });
      assert.equal(result.projections.get(threadId)?.runs[0]?.status, "completed");

      const recorded = transcript.entries.find(
        (entry) =>
          entry.type === "expect_outbound" &&
          (entry.frame as { readonly type?: string }).type === "session.create",
      ) as { readonly frame: { readonly input: { readonly permissions: unknown } } };
      const rules = recorded.frame.input.permissions as ReadonlyArray<{
        readonly action: string;
        readonly effect: string;
      }>;
      const lastFor = (action: string) =>
        rules.findLast((rule) => rule.action === action || rule.action === "*");
      assert.equal(lastFor("shell")?.effect, "deny");
      assert.equal(lastFor("edit")?.effect, "deny");
      assert.isFalse(rules.some((rule) => rule.effect === "ask"));

      // The same thread without side: upstream's rules, which ask before a shell command.
      const plain = sessionRules(
        { runtimeMode: "approval-required", interactionMode: "default" },
        [],
        [],
        null,
      );
      assert.equal(
        plain.findLast((rule: { readonly action: string }) => rule.action === "shell")?.effect,
        "ask",
      );
    }).pipe(Effect.scoped),
  );
});

describe("refusal by name", () => {
  it.effect("a provider without a read-only run is refused by name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const declared = (driver: string, capabilities: OrchestrationV2ProviderCapabilities) => ({
          driver,
          capabilities,
        });
        const registryCapabilities = yield* Effect.gen(function* () {
          const raw = yield* readFixture(fixture("simple/registry_transcript.ndjson"));
          const transcript = yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript({
            ...raw,
            entries: [],
          });
          return yield* Effect.gen(function* () {
            const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
            const [instanceId] = yield* registry.list();
            return yield* (yield* registry.get(instanceId!)).getCapabilities();
          }).pipe(
            Effect.provide(
              AcpRegistryOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(
                transcript,
              ).pipe(Layer.provide(McpProviderSessions.layer)),
            ),
          );
        }).pipe(Effect.scoped);
        // Doubles carrying each adapter's own declaration.
        const harness = yield* makeHarness("refused-by-name", [
          declared("codex", CodexProviderCapabilitiesV2),
          declared("antigravity", makeAntigravityAcpAdapterFlavor({} as never).capabilities),
          declared("acpRegistry", registryCapabilities),
        ]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const antigravitySource = yield* context.createThread({
              threadId: "antigravity-source",
              driver: "antigravity",
            });
            yield* context.turn(antigravitySource, "message:antigravity:1", "first");
            const antigravityRun = (yield* context.orchestrator.getThreadProjection(
              antigravitySource,
            )).runs[0]!;
            assert.equal(antigravityRun.status, "completed");
            const codexSource = yield* context.createThread({
              threadId: "codex-source",
              driver: "codex",
            });
            yield* context.turn(codexSource, "message:codex:1", "first");
            const codexRun = (yield* context.orchestrator.getThreadProjection(codexSource))
              .runs[0]!;
            const startedBefore = harness.log.started.length;

            const refusals = [
              [
                "aside on Antigravity",
                context.dispatch({
                  type: "houston.aside.start",
                  commandId: CommandId.make("aside:antigravity"),
                  sourceThreadId: antigravitySource,
                  asideThreadId: ThreadId.make("aside-antigravity"),
                  messageId: MessageId.make("message:aside-antigravity"),
                  text: "Why?",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                }),
                "Antigravity",
                "aside-antigravity",
              ],
              [
                "reviewer on the ACP registry",
                context.dispatch({
                  type: "houston.second-opinion.request",
                  commandId: CommandId.make("review:registry"),
                  sourceThreadId: codexSource,
                  runId: codexRun.id,
                  reviewThreadId: ThreadId.make("review-registry"),
                  modelSelection: selection("acpRegistry"),
                  createdBy: "user",
                  creationSource: "web",
                }),
                "ACP Registry",
                "review-registry",
              ],
            ] as const;
            for (const [name, command, provider, threadId] of refusals) {
              const error = yield* Effect.flip(command);
              let capability: unknown;
              for (
                let cause: unknown = error;
                typeof cause === "object" && cause !== null;
                cause = (cause as { readonly cause?: unknown }).cause
              ) {
                if (
                  (cause as { readonly _tag?: string })._tag ===
                  "CommandPolicyCapabilityUnsupportedError"
                ) {
                  capability = (cause as { readonly capability?: unknown }).capability;
                  break;
                }
              }
              assert.equal(capability, "read_only_run", name);
              assert.equal(
                userFacingDispatchErrorMessage(error),
                `${provider} cannot run read-only, so it cannot hold an aside or give a second opinion.`,
                name,
              );
              const shell = yield* context.orchestrator.getShellSnapshot();
              assert.isFalse(
                shell.threads.some((thread) => thread.id === threadId),
                name,
              );
            }
            yield* context.settle;
            assert.lengthOf(harness.log.started.slice(startedBefore), 0, "no run starts");

            // A Codex reviewer for an Antigravity turn is accepted.
            yield* context.dispatch({
              type: "houston.second-opinion.request",
              commandId: CommandId.make("review:codex"),
              sourceThreadId: antigravitySource,
              runId: antigravityRun.id,
              reviewThreadId: ThreadId.make("review-codex"),
              modelSelection: selection("codex"),
              createdBy: "user",
              creationSource: "web",
            });
            yield* context.settle;
            const review = yield* context.orchestrator.getThreadProjection(
              ThreadId.make("review-codex"),
            );
            assert.equal(review.thread.side?.kind, "secondOpinion");
            assert.equal(review.runs[0]?.status, "completed");
          }),
        );
      }),
    ),
  );
});

describe("the reviewed diff", () => {
  it.effect("the review carries the reviewed turn's diff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("reviewed-diff");
        const append = (line: string) => (cwd: string) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const readme = path.join(cwd, "README.md");
            yield* fs.writeFileString(readme, `${yield* fs.readFileString(readme)}${line}\n`);
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
        harness.script.edits.set("message:source:1", append("first turn line"));
        harness.script.edits.set("message:source:2", append("second turn line"));
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const source = yield* context.createThread({ threadId: "source", driver: "codex" });
            yield* context.turn(source, "message:source:1", "add the first line");
            yield* context.turn(source, "message:source:2", "add the second line");
            const projection = yield* context.orchestrator.getThreadProjection(source);
            const second = projection.runs[1]!;
            assert.equal(second.status, "completed");
            assert.equal(second.ordinal, 2);
            yield* context.dispatch({
              type: "houston.second-opinion.request",
              commandId: CommandId.make("review"),
              sourceThreadId: source,
              runId: second.id,
              reviewThreadId: ThreadId.make("review"),
              modelSelection: selection("claudeAgent"),
              createdBy: "user",
              creationSource: "web",
            });
            const review = yield* context.orchestrator.getThreadProjection(ThreadId.make("review"));
            const prompt = review.messages.find(
              (message) => message.id === review.runs[0]?.userMessageId,
            )?.text;
            assert.isDefined(prompt);
            assert.include(prompt, "README.md");
            assert.include(prompt, "+second turn line");
            assert.notInclude(prompt, "+first turn line");
            assert.include(prompt, "add the second line");
            assert.notInclude(prompt, "No diff is recorded for this turn.");
          }),
        );
      }),
    ),
  );
});

const MCP_CONFIG_LAUNCH_ARGS = Schema.decodeSync(ClaudeSettings)({
  launchArgs: "--mcp-config /home/user/mcp.json",
});

describe("user MCP servers", () => {
  it.effect("a side thread loads no user MCP servers", () =>
    Effect.gen(function* () {
      // Claude: only the servers Houston passes, and launch arguments cannot add one.
      const options = makeClaudeQueryOptions({
        modelSelection: selection("claudeAgent", "claude-sonnet-4-6"),
        nativeThreadId: "native:side-mcp",
        resume: false,
        cwd: "/work",
        settings: MCP_CONFIG_LAUNCH_ARGS,
        permissionMode: "dontAsk",
        strictMcpConfig: true,
      });
      assert.isTrue(options.strictMcpConfig);
      assert.isUndefined(options.mcpServers);
      assert.isUndefined(options.extraArgs?.["mcp-config"]);

      // The Claude side thread's query, as the adapter opens it.
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
      const raw = yield* readFixture(fixture("tool_call_read_only/claude_transcript.ndjson"));
      const modelSelection = selection("claudeAgent", "claude-sonnet-4-6");
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(raw, modelSelection, "claudeAgent"),
      );
      const { harness, assertComplete } = makeClaudeObservedReplayHarness(transcript, (input) =>
        opened.push(input),
      );
      const threadId = ThreadId.make("thread:claude-side");
      yield* replayOnSideThread({
        name: "houston_side_read_only/claude-mcp",
        harness,
        transcript,
        threadId,
        modelSelection,
        prompt: TOOL_CALL_READ_ONLY_PROMPT,
        worktreePath: yield* workspace("claude-mcp"),
      });
      yield* assertComplete;
      assert.isTrue(opened[0]?.options.strictMcpConfig);
      assert.deepEqual(Object.keys(opened[0]?.options.mcpServers ?? {}), []);

      // Codex: every thread start, resume and fork replaces the configured servers with none.
      const params = codexThreadRuntimeParams({
        mcpSession: undefined,
        runtimePolicy: READ_ONLY_POLICY,
      });
      assert.deepEqual(params.config.mcp_servers, {});
      assert.isFalse(Object.keys(params.config).some((key) => key.startsWith("mcp_servers.")));
      const plainParams = codexThreadRuntimeParams({
        mcpSession: undefined,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work" },
      });
      assert.notProperty(plainParams.config, "mcp_servers");
    }).pipe(Effect.scoped),
  );
});
