// Each provider family's evidence, replayed from upstream's recorded fixtures through
// OrchestratorV2 with each adapter's own testkit. The one composed fixture,
// houston_claude_steer_lifecycle, names its sources in its transcript_start metadata.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2DomainEvent,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import type { MessageDelivery } from "@t3tools/contracts/houston/messageDelivery";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";

import { AcpRegistryOrchestratorReplayHarness } from "../orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { OpenCode2OrchestratorReplayHarness } from "../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
import type { OrchestratorV2ScenarioResult } from "../orchestration-v2/testkit/OrchestratorScenario.ts";
import {
  CLAUDE_MODEL_SELECTION,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  OPENCODE2_CANCELLED_PROMPT,
  OPENCODE2_QUEUED_PROMPT,
  OPENCODE2_STEER_TEXT,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import {
  findReplayFixture,
  runReplayFixture,
} from "../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { latest, makeHarness, runWith, type DoubleOptions } from "./messageDelivery.testkit.ts";

// The thread service an agent's MCP `thread send` goes through, over the harness's orchestrator.
const threadManagementLayer = ThreadManagementService.layer.pipe(
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("antigravity")]: {
          driver: ProviderDriverKind.make("antigravity"),
          enabled: true,
        },
      },
    }).pipe(Layer.orDie),
  ),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
);

const variantOf = (fixtureName: string, driver: string): ProviderOrchestratorReplayVariant => {
  const variant = findReplayFixture(fixtureName)?.providers.find(
    (provider) => provider.driver === driver,
  );
  if (variant === undefined) throw new Error(`${fixtureName} has no ${driver} recording.`);
  return variant;
};

const replay = <T extends ProviderReplayTranscript, E>(input: {
  readonly fixtureName: string;
  readonly variant: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<T, E>;
  readonly buildInput?: () => OrchestratorFixtureInput;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
  /** Skip upstream's output assertions for a transcript this test rewrote. */
  readonly ownAssertions?: boolean;
}) =>
  runReplayFixture({
    fixtureName: input.fixtureName,
    buildInput: input.buildInput ?? findReplayFixture(input.fixtureName)!.buildInput,
    driver:
      input.ownAssertions === true ? { ...input.variant, assertOutput: () => {} } : input.variant,
    harness: input.harness,
    ...(input.transformTranscript === undefined
      ? {}
      : { transformTranscript: input.transformTranscript }),
    // Codex records workspace paths; its replay runner rewrites them to the replay workspace.
    ...(input.variant.driver === "codex"
      ? {
          materializeWorkspace: (transcript: ProviderReplayTranscript, workspace: string) =>
            Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
        }
      : {}),
  });

// Every delivery recorded for the user message whose text includes `text`: on the message
// while it is queued, then on its user_message item.
const deliveriesOf = (result: OrchestratorV2ScenarioResult, text: string) => {
  const records = result.domainEvents.flatMap((event: OrchestrationV2DomainEvent) =>
    event.type === "turn-item.updated" &&
    event.payload.type === "user_message" &&
    event.payload.text.includes(text)
      ? [{ messageId: event.payload.messageId, delivery: event.payload.delivery }]
      : event.type === "message.updated" &&
          event.payload.role === "user" &&
          event.payload.text.includes(text)
        ? [{ messageId: event.payload.id, delivery: event.payload.delivery }]
        : [],
  );
  const messageId = records[0]?.messageId;
  return records
    .filter((record) => record.messageId === messageId)
    .flatMap((record) => (record.delivery === undefined ? [] : [record.delivery]));
};

const last = (list: ReadonlyArray<MessageDelivery>) => list.at(-1);

const assertReadAtTurnStart = (history: ReadonlyArray<MessageDelivery>, label: string) => {
  assert.deepInclude(history[0], { state: "accepted", adoption: null }, label);
  assert.isTrue(
    history.some((delivery) => delivery.state === "delivered" && delivery.adoption === "reported"),
    `${label}: ${JSON.stringify(history)}`,
  );
  assert.deepInclude(last(history), { state: "adopted", evidence: "turnStarted" }, label);
  assert.isNotNull(last(history)?.providerTurnId ?? null, label);
};

const composedClaudeVariant: ProviderOrchestratorReplayVariant = {
  driver: ProviderDriverKind.make("claudeAgent"),
  transcriptFile: new URL(
    "../orchestration-v2/testkit/fixtures/houston_claude_steer_lifecycle/claude_transcript.ndjson",
    import.meta.url,
  ),
  modelSelection: CLAUDE_MODEL_SELECTION,
  assertOutput: () => {},
};

const COMPOSED_STEER_UUID = "b2e1d4c3-8c5f-4d66-8f21-2e3a4b5c6d72";

/** Removes the steer's own acknowledgement frames from the composed Claude transcript. */
const withoutSteerAcknowledgement = (transcript: ProviderReplayTranscript) => ({
  ...transcript,
  entries: transcript.entries.filter(
    (entry) =>
      !(
        entry.type === "emit_inbound" &&
        (entry.frame as { readonly command_uuid?: unknown }).command_uuid === COMPOSED_STEER_UUID
      ),
  ),
});

describe("send intents per provider family", () => {
  it.effect("a queued message is read when its turn starts", () =>
    Effect.gen(function* () {
      const harnesses = [
        ["claudeAgent", ClaudeOrchestratorReplayHarness],
        ["codex", CodexOrchestratorReplayHarness],
        ["acpRegistry", AcpRegistryOrchestratorReplayHarness],
      ] as const;
      for (const [driver, harness] of harnesses) {
        const result = yield* replay({
          fixtureName: "queued_turn",
          variant: variantOf("queued_turn", driver),
          harness: harness as OrchestratorV2ProviderReplayHarness<
            ProviderReplayTranscript,
            unknown
          >,
        });
        const history = deliveriesOf(result, MULTI_TURN_SECOND_PROMPT);
        assert.deepInclude(history[0], { intent: "queue", route: "ownTurn" }, driver);
        assertReadAtTurnStart(history, driver);
      }
    }),
  );

  it.effect("a Claude steer without acknowledgement is unconfirmed", () =>
    Effect.gen(function* () {
      const result = yield* replay({
        fixtureName: "message_steering",
        variant: variantOf("message_steering", "claudeAgent"),
        harness: ClaudeOrchestratorReplayHarness,
      });
      const history = deliveriesOf(result, MESSAGE_STEERING_STEER_PROMPT);
      assert.isTrue(
        history.some(
          (delivery) => delivery.state === "delivered" && delivery.adoption === "notReported",
        ),
        JSON.stringify(history),
      );
      assert.isFalse(history.some((delivery) => delivery.state === "adopted"));
      assert.deepInclude(last(history), { state: "unconfirmed", evidence: null });
    }),
  );

  it.effect("a Claude lifecycle start adopts only its own steer", () =>
    Effect.gen(function* () {
      const result = yield* replay({
        fixtureName: "houston_claude_steer_lifecycle",
        variant: composedClaudeVariant,
        harness: ClaudeOrchestratorReplayHarness,
        buildInput: findReplayFixture("message_steering")!.buildInput,
        ownAssertions: true,
      });
      const history = deliveriesOf(result, MESSAGE_STEERING_STEER_PROMPT);
      assert.isTrue(
        history.some(
          (delivery) => delivery.state === "delivered" && delivery.adoption === "reported",
        ),
        JSON.stringify(history),
      );
      assert.deepInclude(last(history), {
        state: "adopted",
        adoption: "reported",
        evidence: "claude.commandStarted",
      });

      // Only the foreign uuid's started frame remains: the steer is never adopted.
      const foreignOnly = yield* replay({
        fixtureName: "houston_claude_steer_lifecycle",
        variant: composedClaudeVariant,
        harness: ClaudeOrchestratorReplayHarness,
        buildInput: findReplayFixture("message_steering")!.buildInput,
        transformTranscript: withoutSteerAcknowledgement,
        ownAssertions: true,
      });
      const foreign = deliveriesOf(foreignOnly, MESSAGE_STEERING_STEER_PROMPT);
      assert.isTrue(foreign.some((delivery) => delivery.state === "delivered"));
      assert.isFalse(foreign.some((delivery) => delivery.state === "adopted"));

      // The steer's own `queued` frame without its `started`: queued is not read.
      const queuedOnly = yield* replay({
        fixtureName: "houston_claude_steer_lifecycle",
        variant: composedClaudeVariant,
        harness: ClaudeOrchestratorReplayHarness,
        buildInput: findReplayFixture("message_steering")!.buildInput,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.filter((entry) => {
            const frame = entry.type === "emit_inbound" ? entry.frame : undefined;
            const lifecycle = frame as {
              readonly command_uuid?: unknown;
              readonly state?: unknown;
            };
            return !(
              lifecycle?.command_uuid === COMPOSED_STEER_UUID && lifecycle.state === "started"
            );
          }),
        }),
        ownAssertions: true,
      });
      const queued = deliveriesOf(queuedOnly, MESSAGE_STEERING_STEER_PROMPT);
      assert.isTrue(queued.some((delivery) => delivery.state === "delivered"));
      assert.isFalse(
        queued.some((delivery) => delivery.state === "adopted"),
        JSON.stringify(queued),
      );
    }),
  );

  it.effect("a Claude prompt echo adopts the steer", () =>
    Effect.gen(function* () {
      const echoed = (transcript: ProviderReplayTranscript) => {
        const stripped = withoutSteerAcknowledgement(transcript);
        const lastResult = stripped.entries.findLastIndex(
          (entry) =>
            entry.type === "emit_inbound" &&
            (entry.frame as { readonly type?: unknown }).type === "result",
        );
        return {
          ...stripped,
          entries: stripped.entries.map((entry, index) =>
            index === lastResult && entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame: {
                    ...(entry.frame as object),
                    user_message_uuids: [COMPOSED_STEER_UUID],
                  },
                }
              : entry,
          ),
        } as ProviderReplayTranscript;
      };
      const result = yield* replay({
        fixtureName: "houston_claude_steer_lifecycle",
        variant: composedClaudeVariant,
        harness: ClaudeOrchestratorReplayHarness,
        buildInput: findReplayFixture("message_steering")!.buildInput,
        transformTranscript: echoed,
        ownAssertions: true,
      });
      assert.deepInclude(last(deliveriesOf(result, MESSAGE_STEERING_STEER_PROMPT)), {
        state: "adopted",
        evidence: "claude.promptEcho",
      });
    }),
  );

  it.effect("a Codex steer is read at its own userMessage item", () =>
    Effect.gen(function* () {
      const result = yield* replay({
        fixtureName: "message_steering",
        variant: variantOf("message_steering", "codex"),
        harness: CodexOrchestratorReplayHarness,
      });
      const history = deliveriesOf(result, MESSAGE_STEERING_STEER_PROMPT);
      // The initial prompt's userMessage (recorded after the steer answer) adopts nothing.
      const adoptions = history.filter((delivery) => delivery.state === "adopted");
      assert.lengthOf(adoptions, 1, JSON.stringify(history));
      assert.deepInclude(adoptions[0], {
        intent: "steer",
        route: "activeTurn",
        adoption: "reported",
        evidence: "codex.userMessage",
      });
      const deliveredAt = history.findIndex((delivery) => delivery.state === "delivered");
      assert.isAtLeast(deliveredAt, 0, JSON.stringify(history));
      assert.isAbove(
        history.findIndex((delivery) => delivery.state === "adopted"),
        deliveredAt,
      );
      assert.lengthOf(deliveriesOf(result, MESSAGE_STEERING_INITIAL_PROMPT), 0);

      // Without the steered text's own userMessage item, the initial prompt's item adopts nothing.
      const withoutSteeredItem = yield* replay({
        fixtureName: "message_steering",
        variant: variantOf("message_steering", "codex"),
        harness: CodexOrchestratorReplayHarness,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.filter(
            (entry) =>
              !(
                entry.type === "emit_inbound" &&
                JSON.stringify(entry.frame).includes('"type":"userMessage"') &&
                JSON.stringify(entry.frame).includes(MESSAGE_STEERING_STEER_PROMPT)
              ),
          ),
        }),
        ownAssertions: true,
      });
      const unread = deliveriesOf(withoutSteeredItem, MESSAGE_STEERING_STEER_PROMPT);
      assert.isTrue(unread.some((delivery) => delivery.state === "delivered"));
      assert.isFalse(
        unread.some((delivery) => delivery.state === "adopted"),
        JSON.stringify(unread),
      );
    }),
  );

  it.effect("OpenCode 2 inbox reports each message", () =>
    Effect.gen(function* () {
      const result = yield* replay({
        fixtureName: "opencode2_inbox",
        variant: variantOf("opencode2_inbox", "opencode"),
        harness: OpenCode2OrchestratorReplayHarness,
      });
      assert.deepInclude(last(deliveriesOf(result, OPENCODE2_STEER_TEXT)), {
        intent: "steer",
        state: "adopted",
        adoption: "reported",
        evidence: "opencode.inboxDelivered",
      });
      assertReadAtTurnStart(deliveriesOf(result, OPENCODE2_QUEUED_PROMPT), "queued");
      assert.deepInclude(last(deliveriesOf(result, OPENCODE2_CANCELLED_PROMPT)), {
        intent: "queue",
        state: "dropped",
        reason: "cancelled",
      });
    }),
  );

  it.effect("an OpenCode 2 steer taken back is dropped", () =>
    Effect.gen(function* () {
      // The recording's second inbox delivery is the steer's; report it as a cancellation.
      const cancelled = (transcript: ProviderReplayTranscript) =>
        ({
          ...transcript,
          entries: transcript.entries.map((entry) => {
            if (entry.type !== "emit_inbound" || entry.label !== "session.inbox.delivered.2") {
              return entry;
            }
            const frame = entry.frame as { readonly event: Record<string, unknown> };
            return {
              ...entry,
              frame: { ...frame, event: { ...frame.event, type: "session.inbox.cancelled" } },
            };
          }),
        }) as ProviderReplayTranscript;
      const result = yield* replay({
        fixtureName: "opencode2_inbox",
        variant: variantOf("opencode2_inbox", "opencode"),
        harness: OpenCode2OrchestratorReplayHarness,
        transformTranscript: cancelled,
        ownAssertions: true,
      });
      assert.deepInclude(last(deliveriesOf(result, OPENCODE2_STEER_TEXT)), {
        intent: "steer",
        state: "dropped",
        reason: "providerCancelled",
      });
    }),
  );

  it.effect("queue and interrupt are read at turn start on the ACP family", () =>
    Effect.gen(function* () {
      const queued = yield* replay({
        fixtureName: "queued_turn",
        variant: variantOf("queued_turn", "acpRegistry"),
        harness: AcpRegistryOrchestratorReplayHarness,
      });
      assertReadAtTurnStart(deliveriesOf(queued, MULTI_TURN_SECOND_PROMPT), "registry queue");
      // The registry's message_steering recording is an interrupt and restart: ACP cannot steer.
      const interrupted = yield* replay({
        fixtureName: "message_steering_restart",
        variant: variantOf("message_steering_restart", "acpRegistry"),
        harness: AcpRegistryOrchestratorReplayHarness,
      });
      const history = deliveriesOf(interrupted, MESSAGE_STEERING_STEER_PROMPT);
      assert.deepInclude(history[0], { intent: "interrupt", route: "ownTurn" });
      assertReadAtTurnStart(history, "registry interrupt");
    }),
  );

  // No recording exists for these routes; the double carries each driver's capabilities and
  // emits a running provider turn on start, as every Houston family does (emitsTurnStarted).
  const ownTurnRead = (name: string, options: DoubleOptions, intent: "queue" | "interrupt") =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(name, options);
      return yield* runWith(harness, ({ send, startFirst, deliveries, settle, runningTurn }) =>
        Effect.gen(function* () {
          const runId = yield* startFirst;
          const turn = yield* runningTurn;
          const messageId = MessageId.make(`message:${intent}`);
          yield* send(
            messageId,
            intent,
            intent === "queue"
              ? { type: "queue_after_active" }
              : { type: "restart_active", targetRunId: runId },
          );
          if (intent === "queue") yield* harness.endTurn(turn, "completed");
          yield* settle;
          const history = deliveries(messageId);
          assert.deepInclude(history[0], { intent, route: "ownTurn" }, name);
          assertReadAtTurnStart(history, name);
          assert.equal(harness.started.at(-1)?.message.messageId, messageId, name);
          if (intent === "interrupt") {
            assert.deepEqual(harness.interrupted, [turn.id], name);
            assert.equal(harness.started.at(-1)?.runId, runId, "the same run, a new attempt");
          }
          return harness;
        }),
      );
    });

  it.effect("an interrupting message is read when its replacement turn starts", () =>
    Effect.gen(function* () {
      yield* ownTurnRead("interrupt-codex", { driver: "codex" }, "interrupt");
      yield* ownTurnRead("interrupt-opencode2", { driver: "opencode" }, "interrupt");
    }),
  );

  it.effect("an OpenCode 1 queued message is read when its turn starts", () =>
    ownTurnRead("queue-opencode1", { driver: "opencode" }, "queue").pipe(Effect.asVoid),
  );

  it.effect("an OpenCode 1 interrupting message is read when its replacement turn starts", () =>
    Effect.gen(function* () {
      const harness = yield* ownTurnRead(
        "interrupt-opencode1",
        { driver: "opencode" },
        "interrupt",
      );
      assert.lengthOf(harness.started, 2);
    }),
  );

  it.effect("a steer is refused by name where the provider cannot steer", () =>
    Effect.gen(function* () {
      const forms = ["steer_active", "deliveryIntent", "promote"] as const;
      const providers = [
        ["antigravity", "Antigravity"],
        ["acpRegistry", "ACP Registry"],
      ] as const;
      for (const [driver, name] of providers) {
        for (const form of forms) {
          const harness = yield* makeHarness(`refuse-${driver}-${form}`, {
            driver,
            capabilities: AcpProviderCapabilitiesV2,
          });
          yield* runWith(
            harness,
            ({ send, startFirst, orchestrator, threadId, settle, deliveries }) =>
              Effect.gen(function* () {
                const runId = yield* startFirst;
                const messageId = MessageId.make(`message:refused-${form}`);
                let refused: unknown;
                if (form === "promote") {
                  yield* send(messageId, "queued first", { type: "queue_after_active" });
                  const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                    (run) => run.status === "queued",
                  )!;
                  refused = yield* orchestrator
                    .dispatch({
                      type: "queued-message.promote-to-steer",
                      commandId: CommandId.make("promote"),
                      threadId,
                      queuedRunId: queued.id,
                      targetRunId: runId,
                    })
                    .pipe(Effect.flip);
                } else {
                  const attempt =
                    form === "steer_active"
                      ? send(messageId, "steer", { type: "steer_active", targetRunId: runId })
                      : send(messageId, "steer", { type: "start_immediately" }, "steer");
                  refused = yield* Effect.flip(attempt);
                }
                const label = `${driver}/${form}`;
                assert.equal(
                  userFacingDispatchErrorMessage(refused),
                  `${name} cannot redirect an active run. Stop it first, then send the message.`,
                  label,
                );
                assert.include(JSON.stringify(refused), `"capability":"active_steering"`, label);
                yield* settle;
                const projection = yield* orchestrator.getThreadProjection(threadId);
                const stored = projection.messages.find((message) => message.id === messageId);
                if (form === "promote") {
                  // The queued message stays queued, untouched.
                  const queuedRun = projection.runs.find((run) => run.status === "queued");
                  assert.equal(stored?.runId, queuedRun?.id, label);
                  assert.deepInclude(
                    latest(deliveries(messageId)),
                    { intent: "queue", state: "accepted" },
                    label,
                  );
                } else {
                  assert.isUndefined(stored, label);
                  assert.lengthOf(deliveries(messageId), 0, label);
                }
                assert.lengthOf(harness.interrupted, 0, label);
                assert.lengthOf(harness.steered, 0, label);
                assert.lengthOf(harness.started, 1, label);
              }),
          );
        }
      }
      // An interrupt on Antigravity and a steer on Codex are accepted.
      yield* ownTurnRead(
        "accept-antigravity-interrupt",
        { driver: "antigravity", capabilities: AcpProviderCapabilitiesV2 },
        "interrupt",
      );
      const codex = yield* makeHarness("accept-codex-steer");
      yield* runWith(codex, ({ send, startFirst, settle, deliveries }) =>
        Effect.gen(function* () {
          const runId = yield* startFirst;
          const messageId = MessageId.make("message:codex-steer");
          yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
          yield* settle;
          assert.lengthOf(codex.steered, 1);
          assert.deepInclude(latest(deliveries(messageId)), {
            intent: "steer",
            state: "delivered",
          });
        }),
      );
    }),
  );

  it.effect(
    "an automatic thread send keeps upstream's resolution where the provider cannot steer",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness("auto-thread-send-antigravity", {
          driver: "antigravity",
          capabilities: AcpProviderCapabilitiesV2,
        });
        yield* runWith(harness, ({ startFirst, settle, deliveries, threadId, runningTurn }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const turn = yield* runningTurn;
            const messageId = MessageId.make("message:auto-thread-send");
            // An agent's MCP `thread send` with no mode sends `auto`.
            const threads = yield* ThreadManagementService.ThreadManagementService;
            yield* threads.sendToThread({
              projectId: ProjectId.make("project:message-delivery"),
              commandId: CommandId.make("auto-thread-send"),
              threadId,
              messageId,
              text: "agent follow-up",
              attachments: [],
              mode: "auto",
              createdBy: "agent",
              creationSource: "mcp",
            });
            yield* settle;
            // Upstream interrupts the turn and restarts it with the message; nothing is refused.
            assert.deepEqual(harness.interrupted, [turn.id]);
            assert.lengthOf(harness.steered, 0);
            assert.equal(harness.started.at(-1)?.message.messageId, messageId);
            assert.equal(harness.started.at(-1)?.runId, runId);
            const history = deliveries(messageId);
            assert.deepInclude(history[0], { intent: "interrupt", route: "ownTurn" });
            assertReadAtTurnStart(history, "auto thread send");
          }).pipe(Effect.provide(threadManagementLayer)),
        );
      }),
  );

  it.effect(
    "a steer that switches provider instance is refused where the provider cannot steer",
    () =>
      Effect.gen(function* () {
        const options = { driver: "antigravity", capabilities: AcpProviderCapabilitiesV2 };
        const harness = yield* makeHarness("switch-steer-antigravity", options);
        const other = yield* makeHarness("switch-steer-antigravity-2", {
          ...options,
          instanceId: "antigravity-2",
        });
        yield* runWith(
          harness,
          ({ startFirst, orchestrator, threadId, settle, deliveries }) =>
            Effect.gen(function* () {
              const runId = yield* startFirst;
              const messageId = MessageId.make("message:switch-steer");
              const refused = yield* Effect.flip(
                orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make("switch-steer"),
                  threadId,
                  messageId,
                  text: "steer on the other instance",
                  attachments: [],
                  modelSelection: other.modelSelection,
                  dispatchMode: { type: "steer_active", targetRunId: runId },
                  createdBy: "user",
                  creationSource: "web",
                }),
              );
              assert.equal(
                userFacingDispatchErrorMessage(refused),
                "Antigravity cannot redirect an active run. Stop it first, then send the message.",
              );
              assert.include(JSON.stringify(refused), `"capability":"active_steering"`);
              yield* settle;
              const projection = yield* orchestrator.getThreadProjection(threadId);
              assert.isUndefined(projection.messages.find((message) => message.id === messageId));
              assert.lengthOf(deliveries(messageId), 0);
              assert.lengthOf(harness.interrupted, 0);
              assert.lengthOf(harness.started, 1);
              assert.lengthOf(other.started, 0);
            }),
          { others: [other] },
        );
      }),
  );

  it.effect("an interrupt is refused by name on Claude", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("refuse-claude-interrupt", {
        driver: "claudeAgent",
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      yield* runWith(harness, ({ send, startFirst }) =>
        Effect.gen(function* () {
          const runId = yield* startFirst;
          const refused = yield* Effect.flip(
            send(MessageId.make("message:claude-interrupt"), "interrupt", {
              type: "restart_active",
              targetRunId: runId,
            }),
          );
          assert.equal(
            userFacingDispatchErrorMessage(refused),
            "Claude cannot redirect an active run. Stop it first, then send the message.",
          );
          assert.include(JSON.stringify(refused), `"capability":"interrupt_restart_steering"`);
          assert.lengthOf(harness.interrupted, 0);
        }),
      );
    }),
  );

  it.effect("queue and interrupt are read at turn start on Antigravity", () =>
    Effect.gen(function* () {
      const options = { driver: "antigravity", capabilities: AcpProviderCapabilitiesV2 };
      yield* ownTurnRead("antigravity-queue", options, "queue");
      yield* ownTurnRead("antigravity-interrupt", options, "interrupt");
    }),
  );
});
