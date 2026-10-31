// Asides, second opinions and Send to thread through the orchestrator and its effect worker,
// with the provider doubles of sideThreads.testkit.ts. The doubles declare a read-only run in
// their test capabilities; that proves orchestration, and the families test proves sandboxes.
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { layerNoReadOnlyThreads } from "./sideThreads.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import {
  CLAUDE,
  CODEX,
  type Context,
  makeHarness,
  runWith,
  selection,
  withReadOnlyRun,
} from "./sideThreads.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

const READ_ONLY = {
  interactionMode: "default",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
} as const;

const ASIDE_NEEDS_FINISHED_TURN = "An aside needs a finished turn in this thread.";
const NEEDS_ANOTHER_PROVIDER =
  "A second opinion needs a different provider from the one that ran this turn.";
const ONLY_COMPLETED_TURN = "Only a completed turn can get a second opinion.";
const ONLY_THROUGH_SEND = "A side thread's result enters its thread only through Send to thread.";
const ALREADY_SENT = "This second opinion is already in the thread.";
const ONLY_FINISHED_REVIEW = "Only a finished second opinion can be sent to the thread.";
const SIDE_READ_ONLY = "A side thread is read-only.";
const ANTIGRAVITY_REFUSAL =
  "Antigravity cannot run read-only, so it cannot hold an aside or give a second opinion.";

const startAside = (
  context: Context,
  input: {
    readonly source: ThreadId;
    readonly aside: string;
    readonly text?: string;
    readonly commandId?: string;
  },
) =>
  context.dispatch({
    type: "houston.aside.start",
    commandId: CommandId.make(input.commandId ?? `aside:${input.aside}`),
    sourceThreadId: input.source,
    asideThreadId: ThreadId.make(input.aside),
    messageId: MessageId.make(`message:${input.aside}`),
    text: input.text ?? "What does this turn change?",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  });

const requestReview = (
  context: Context,
  input: {
    readonly source: ThreadId;
    readonly runId: RunId;
    readonly review: string;
    readonly driver: string;
    readonly model?: string;
  },
) =>
  context.dispatch({
    type: "houston.second-opinion.request",
    commandId: CommandId.make(`review:${input.review}`),
    sourceThreadId: input.source,
    runId: input.runId,
    reviewThreadId: ThreadId.make(input.review),
    modelSelection: selection(input.driver, input.model),
    createdBy: "user",
    creationSource: "web",
  });

const sendToThread = (context: Context, sideThreadId: string, runId: RunId, commandId: string) =>
  context.dispatch({
    type: "houston.side-thread.send",
    commandId: CommandId.make(commandId),
    sideThreadId: ThreadId.make(sideThreadId),
    runId,
  });

const projectionOf = (context: Context, threadId: string) =>
  context.orchestrator.getThreadProjection(ThreadId.make(threadId));

const runIds = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map((run) => run.id);

/** The user-facing text of a refused command. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => userFacingDispatchErrorMessage(error)));

/** The capability a refused command names, at any depth of its cause. */
const refusedCapability = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record._tag === "CommandPolicyCapabilityUnsupportedError") {
      return typeof record.capability === "string" ? record.capability : undefined;
    }
    current = record.cause;
  }
  return undefined;
};

/** A source thread on `driver` whose first turn completed with `reply`. */
const sourceWithTurn = (
  context: Context,
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  input: {
    readonly threadId: string;
    readonly driver: string;
    readonly reply?: string;
    readonly title?: string;
    readonly interactionMode?: "default" | "plan";
  },
) =>
  Effect.gen(function* () {
    const source = yield* context.createThread({
      threadId: input.threadId,
      driver: input.driver,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
    });
    const messageId = `message:${input.threadId}:1`;
    if (input.reply !== undefined) harness.script.replies.set(messageId, input.reply);
    yield* context.turn(source, messageId, `first request in ${input.threadId}`);
    const projection = yield* context.orchestrator.getThreadProjection(source);
    assert.equal(projection.runs[0]?.status, "completed");
    return { source, firstRunId: projection.runs[0]!.id };
  });

describe("an aside", () => {
  it.effect("an aside forks from the latest finished turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // [completed #1, running #2] -> #1
        const running = yield* makeHarness("aside-latest-running");
        yield* runWith(running, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, running, {
              threadId: "source",
              driver: "codex",
            });
            running.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "second request");
            const before = yield* context.orchestrator.getThreadProjection(source);
            assert.equal(before.runs[1]?.status, "running");
            yield* startAside(context, { source, aside: "aside", text: "Why this file?" });
            yield* context.settle;
            const aside = yield* projectionOf(context, "aside");
            assert.deepEqual(aside.thread.side, {
              kind: "aside",
              sourceThreadId: source,
              sourceRunId: firstRunId,
            });
            assert.equal(aside.thread.lineage.relationshipToParent, "fork");
            assert.deepEqual(aside.thread.forkedFrom, {
              type: "run",
              threadId: source,
              runId: firstRunId,
            });
            assert.equal(aside.thread.providerInstanceId, before.thread.providerInstanceId);
            assert.deepEqual(aside.thread.modelSelection, before.thread.modelSelection);
            assert.equal(aside.thread.worktreePath, running.cwd);
            const firstMessage = aside.messages.find(
              (message) => message.id === "message:aside" && message.role === "user",
            );
            assert.equal(firstMessage?.text, "Why this file?");
            const started = running.log.started.filter((turn) => turn.input.threadId === "aside");
            assert.lengthOf(started, 1);
            assert.equal(started[0]?.input.message.messageId, "message:aside");
          }),
        );

        // [completed #1, interrupted #2] -> #2
        const interrupted = yield* makeHarness("aside-latest-interrupted");
        yield* runWith(interrupted, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, interrupted, {
              threadId: "source",
              driver: "codex",
            });
            interrupted.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "second request");
            const second = (yield* context.orchestrator.getThreadProjection(source)).runs[1]!;
            yield* context.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("interrupt:2"),
              threadId: source,
              runId: second.id,
            });
            yield* context.settle;
            const stopped = (yield* context.orchestrator.getThreadProjection(source)).runs[1]!;
            assert.equal(stopped.status, "interrupted");
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const aside = yield* projectionOf(context, "aside");
            assert.deepInclude(aside.thread.side, { sourceRunId: second.id });
            assert.deepEqual(aside.thread.forkedFrom, {
              type: "run",
              threadId: source,
              runId: second.id,
            });
          }),
        );

        // A workspace without git keeps no checkpoints; the aside forks all the same.
        const noGit = yield* makeHarness("aside-no-git", undefined, { git: false });
        yield* runWith(noGit, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, noGit, {
              threadId: "source",
              driver: "codex",
            });
            const sourceProjection = yield* context.orchestrator.getThreadProjection(source);
            assert.lengthOf(
              sourceProjection.checkpoints.filter((checkpoint) => checkpoint.status === "ready"),
              0,
            );
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const aside = yield* projectionOf(context, "aside");
            assert.deepInclude(aside.thread.side, { sourceRunId: firstRunId });
            assert.isTrue(
              noGit.log.started.some((turn) => turn.input.threadId === "aside"),
              "the aside's first run starts",
            );
          }),
        );
      }),
    ),
  );

  it.effect("an aside never touches the running source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("aside-untouched");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            harness.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "keep working");
            const before = yield* context.orchestrator.getThreadProjection(source);
            const sourceProviderThreads = new Set(
              before.providerThreads.map((thread) => thread.id),
            );
            const eventsBefore = context.events.length;
            const startedBefore = harness.log.started.length;
            const steeredBefore = harness.log.steered.length;
            const interruptedBefore = harness.log.interrupted.length;

            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const aside = yield* projectionOf(context, "aside");
            assert.equal(aside.runs[0]?.status, "completed", "the aside's run completes");

            const after = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);
            assert.deepEqual(after.providerTurns, before.providerTurns);
            // The fork's transfer is listed on both ends; nothing transfers into the source.
            assert.deepEqual(
              after.contextTransfers.filter((transfer) => transfer.targetThreadId === source),
              before.contextTransfers.filter((transfer) => transfer.targetThreadId === source),
            );
            assert.deepEqual(
              context.events.slice(eventsBefore).filter((event) => event.threadId === source),
              [],
            );
            const laterTurns = harness.log.started.slice(startedBefore);
            assert.isTrue(laterTurns.every((turn) => turn.input.threadId === "aside"));
            assert.isFalse(
              laterTurns.some((turn) => sourceProviderThreads.has(turn.input.providerThread.id)),
            );
            assert.lengthOf(harness.log.steered.slice(steeredBefore), 0);
            assert.lengthOf(harness.log.interrupted.slice(interruptedBefore), 0);
          }),
        );
      }),
    ),
  );

  it.effect("an aside needs a finished turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("aside-needs-finished");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const source = yield* context.createThread({ threadId: "source", driver: "codex" });
            harness.script.hold.add("message:source:1");
            yield* context.turn(source, "message:source:1", "still going");
            const error = yield* Effect.flip(startAside(context, { source, aside: "aside" }));
            assert.equal((error as { readonly _tag: string })._tag, "OrchestratorDispatchError");
            assert.equal(userFacingDispatchErrorMessage(error), ASIDE_NEEDS_FINISHED_TURN);
            const shell = yield* context.orchestrator.getShellSnapshot();
            assert.isFalse(shell.threads.some((thread) => thread.id === "aside"));
          }),
        );
      }),
    ),
  );

  it.effect("an aside waits for a running turn on a provider that forks only idle sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("aside-opencode-running", [
          CODEX,
          {
            driver: "opencode",
            capabilities: withReadOnlyRun(CodexProviderCapabilitiesV2, "permissionRules"),
          },
        ]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "opencode",
            });
            harness.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "still going");
            const before = yield* context.orchestrator.getThreadProjection(source);
            const startedBefore = harness.log.started.length;
            const error = yield* Effect.flip(startAside(context, { source, aside: "aside" }));
            assert.equal((error as { readonly _tag: string })._tag, "OrchestratorDispatchError");
            assert.equal(
              userFacingDispatchErrorMessage(error),
              "OpenCode cannot fork a thread while its turn runs, so an aside has to wait for this turn to finish.",
            );
            yield* context.settle;
            const shell = yield* context.orchestrator.getShellSnapshot();
            assert.isFalse(shell.threads.some((thread) => thread.id === "aside"));
            assert.lengthOf(harness.log.forks, 0);
            assert.equal(harness.log.started.length, startedBefore);
            const after = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);

            // Once the turn has finished, the aside starts.
            yield* harness.release("message:source:2");
            yield* context.settle;
            yield* startAside(context, { source, aside: "aside-later" });
            const aside = yield* projectionOf(context, "aside-later");
            assert.equal(aside.thread.side?.kind, "aside");
          }),
        );
      }),
    ),
  );

  it.effect("a follow-up in an aside stays read-only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("aside-follow-up");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
              interactionMode: "plan",
            });
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            yield* context.turn(ThreadId.make("aside"), "message:aside:follow-up", "And then?");
            const followUp = harness.log.started.find(
              (turn) => turn.input.message.messageId === "message:aside:follow-up",
            );
            assert.isDefined(followUp);
            assert.equal(followUp.input.threadId, "aside");
            assert.deepInclude(followUp.input.runtimePolicy, READ_ONLY);
            const aside = yield* projectionOf(context, "aside");
            assert.lengthOf(aside.runs, 2);
            assert.equal(aside.runs[1]?.status, "completed");
          }),
        );
      }),
    ),
  );
});

describe("a second opinion", () => {
  it.effect("a second opinion opens a review thread on the reviewer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("review-opens");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
              title: "Fix the parser",
              reply: "I rewrote the tokenizer.",
            });
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
              model: "claude-sonnet-4-6",
            });
            yield* context.settle;
            const review = yield* projectionOf(context, "review");
            const sourceProjection = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(review.thread.side, {
              kind: "secondOpinion",
              sourceThreadId: source,
              sourceRunId: firstRunId,
            });
            assert.equal(review.thread.projectId, sourceProjection.thread.projectId);
            assert.equal(review.thread.worktreePath, harness.cwd);
            assert.deepEqual(
              review.thread.modelSelection,
              selection("claudeAgent", "claude-sonnet-4-6"),
            );
            assert.equal(review.thread.title, "Second opinion: Fix the parser");
            const prompt = review.messages.find(
              (message) => message.role === "user" && message.id === review.runs[0]?.userMessageId,
            );
            assert.isDefined(prompt);
            assert.include(prompt.text, "first request in source");
            assert.include(prompt.text, "I rewrote the tokenizer.");
            const started = harness.log.started.filter((turn) => turn.input.threadId === "review");
            assert.lengthOf(started, 1);
            assert.equal(started[0]?.driver, "claudeAgent");
            assert.equal(started[0]?.input.message.text, prompt.text);
          }),
        );
      }),
    ),
  );

  it.effect("a second opinion needs another provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("review-needs-another");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const claudeTurn = yield* sourceWithTurn(context, harness, {
              threadId: "claude-source",
              driver: "claudeAgent",
            });
            const refused = yield* refusal(
              requestReview(context, {
                source: claudeTurn.source,
                runId: claudeTurn.firstRunId,
                review: "same-driver",
                driver: "claudeAgent",
                model: "claude-opus-4-7",
              }),
            );
            assert.equal(refused, NEEDS_ANOTHER_PROVIDER);
            const codexTurn = yield* sourceWithTurn(context, harness, {
              threadId: "codex-source",
              driver: "codex",
            });
            yield* requestReview(context, {
              source: codexTurn.source,
              runId: codexTurn.firstRunId,
              review: "other-driver",
              driver: "claudeAgent",
            });
            const shell = yield* context.orchestrator.getShellSnapshot();
            assert.isFalse(shell.threads.some((thread) => thread.id === "same-driver"));
            assert.isTrue(shell.threads.some((thread) => thread.id === "other-driver"));
          }),
        );
      }),
    ),
  );

  it.effect("a second opinion needs another provider driver, not another instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Two Claude instances, as with a work and a personal account.
        const harness = yield* makeHarness("review-needs-another-driver", [
          CODEX,
          CLAUDE,
          { ...CLAUDE, instanceId: "claudeWork" },
        ]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const claudeTurn = yield* sourceWithTurn(context, harness, {
              threadId: "claude-source",
              driver: "claudeAgent",
            });
            const refused = yield* refusal(
              requestReview(context, {
                source: claudeTurn.source,
                runId: claudeTurn.firstRunId,
                review: "other-instance",
                driver: "claudeWork",
              }),
            );
            assert.equal(refused, NEEDS_ANOTHER_PROVIDER);
            const shell = yield* context.orchestrator.getShellSnapshot();
            assert.isFalse(shell.threads.some((thread) => thread.id === "other-instance"));
          }),
        );
      }),
    ),
  );

  it.effect("only a completed turn can be reviewed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("review-only-completed");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            harness.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "second");
            const second = (yield* context.orchestrator.getThreadProjection(source)).runs[1]!;
            assert.equal(second.status, "running");
            assert.equal(
              yield* refusal(
                requestReview(context, {
                  source,
                  runId: second.id,
                  review: "running",
                  driver: "claudeAgent",
                }),
              ),
              ONLY_COMPLETED_TURN,
            );
            yield* context.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("interrupt:2"),
              threadId: source,
              runId: second.id,
            });
            yield* context.settle;
            assert.equal(
              (yield* context.orchestrator.getThreadProjection(source)).runs[1]?.status,
              "interrupted",
            );
            assert.equal(
              yield* refusal(
                requestReview(context, {
                  source,
                  runId: second.id,
                  review: "interrupted",
                  driver: "claudeAgent",
                }),
              ),
              ONLY_COMPLETED_TURN,
            );
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "completed",
              driver: "claudeAgent",
            });
            const shell = yield* context.orchestrator.getShellSnapshot();
            const ids = shell.threads.map((thread) => String(thread.id));
            assert.notInclude(ids, "running");
            assert.notInclude(ids, "interrupted");
            assert.include(ids, "completed");
          }),
        );
      }),
    ),
  );

  it.effect("a side thread's result stays out of its source", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("review-stays-out");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            const before = yield* context.orchestrator.getThreadProjection(source);
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
            });
            yield* context.settle;
            const review = yield* projectionOf(context, "review");
            assert.equal(review.runs[0]?.status, "completed", "the review run completes");
            const after = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(after.messages, before.messages);
            assert.deepEqual(runIds(after), runIds(before));
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.contextTransfers, before.contextTransfers);

            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            for (const sideThreadId of ["review", "aside"]) {
              const refused = yield* refusal(
                context.dispatch({
                  type: "thread.merge_back",
                  commandId: CommandId.make(`merge-back:${sideThreadId}`),
                  sourceThreadId: ThreadId.make(sideThreadId),
                  targetThreadId: source,
                  sourcePoint: { type: "latest_stable" },
                  createdBy: "user",
                  creationSource: "web",
                }),
              );
              assert.equal(refused, ONLY_THROUGH_SEND, sideThreadId);
            }
            const final = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(final.messages, before.messages);
            // The aside's fork transfer is listed on its source; nothing transfers into it.
            assert.deepEqual(
              final.contextTransfers.filter((transfer) => transfer.targetThreadId === source),
              before.contextTransfers.filter((transfer) => transfer.targetThreadId === source),
            );
          }),
        );
      }),
    ),
  );
});

/** A source on Codex with a completed turn, and a completed Claude review of it. */
const reviewed = (
  context: Context,
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  reviewText: string,
) =>
  Effect.gen(function* () {
    const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
      threadId: "source",
      driver: "codex",
    });
    yield* requestReview(context, {
      source,
      runId: firstRunId,
      review: "review",
      driver: "claudeAgent",
    });
    const reviewProjection = yield* projectionOf(context, "review");
    const reviewMessageId = reviewProjection.runs[0]!.userMessageId;
    harness.script.replies.set(reviewMessageId, reviewText);
    yield* context.settle;
    const reviewRun = (yield* projectionOf(context, "review")).runs[0]!;
    assert.equal(reviewRun.status, "completed");
    return { source, firstRunId, reviewRunId: reviewRun.id };
  });

const sideMessage = (projection: OrchestrationV2ThreadProjection, runId: RunId) =>
  projection.messages.filter((message) => message.id === `side-${runId}`);

describe("Send to thread", () => {
  it.effect("send to thread queues the review as the next message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Source idle: the review starts a run, and Markdown arrives byte for byte.
        const reviewText = [
          "## Findings",
          "",
          "- `parse()` drops the last token.",
          "",
          "```ts",
          "const tokens = input.split(/\\s+/); // keep\t tabs and  spaces",
          "```",
          "",
          "> Trailing quote with *emphasis*.  ",
        ].join("\n");
        const idle = yield* makeHarness("send-idle");
        yield* runWith(idle, (context) =>
          Effect.gen(function* () {
            const { source, reviewRunId } = yield* reviewed(context, idle, reviewText);
            yield* sendToThread(context, "review", reviewRunId, "send:1");
            const projection = yield* context.orchestrator.getThreadProjection(source);
            const sent = sideMessage(projection, reviewRunId);
            assert.lengthOf(sent, 1);
            assert.equal(sent[0]?.text, `Second opinion from Claude on turn 1:\n\n${reviewText}`);
            assert.equal(sent[0]?.role, "user");
            const run = projection.runs.find(
              (candidate) => candidate.userMessageId === sent[0]?.id,
            );
            assert.isDefined(run);
            assert.notEqual(run.status, "queued", "an idle source starts the review at once");
            yield* context.settle;
            assert.isTrue(
              idle.log.started.some(
                (turn) =>
                  turn.input.threadId === source &&
                  turn.input.message.messageId === `side-${reviewRunId}`,
              ),
            );
          }),
        );

        // Source running with one queued message: the review queues behind it.
        const busy = yield* makeHarness("send-busy");
        yield* runWith(busy, (context) =>
          Effect.gen(function* () {
            const { source, reviewRunId } = yield* reviewed(context, busy, "Looks right.");
            busy.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "keep going");
            yield* context.send(source, "message:queued", "then this", {
              type: "queue_after_active",
            });
            yield* sendToThread(context, "review", reviewRunId, "send:busy");
            const projection = yield* context.orchestrator.getThreadProjection(source);
            const sent = sideMessage(projection, reviewRunId);
            assert.lengthOf(sent, 1);
            assert.equal(sent[0]?.delivery?.intent, "queue");
            const sentRun = projection.runs.find((run) => run.userMessageId === sent[0]?.id);
            assert.equal(sentRun?.status, "queued");
            yield* busy.release("message:source:2");
            yield* context.settle;
            const order = busy.log.started
              .filter((turn) => turn.input.threadId === source)
              .map((turn) => turn.input.message.messageId);
            assert.deepEqual(order.slice(-2), ["message:queued", `side-${reviewRunId}`]);
          }),
        );
      }),
    ),
  );

  it.effect("send to thread queues the review as the next message from the run's last answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("send-last-answer");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            // The reviewed run writes commentary, then its report.
            harness.script.commentary.set("message:source:1", "Reading parse.ts first.");
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
              reply: "Report: split keeps empty tokens now.",
            });
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
            });
            const reviewProjection = yield* projectionOf(context, "review");
            const reviewMessageId = reviewProjection.runs[0]!.userMessageId;
            const prompt = reviewProjection.messages.find(
              (message) => message.id === reviewMessageId,
            )?.text;
            assert.include(prompt, "Report: split keeps empty tokens now.");
            assert.notInclude(prompt, "Reading parse.ts first.");

            // The review writes commentary, then the review itself.
            harness.script.commentary.set(reviewMessageId, "Let me read the diff.");
            harness.script.replies.set(reviewMessageId, "Review: the change is right.");
            yield* context.settle;
            const reviewRun = (yield* projectionOf(context, "review")).runs[0]!;
            assert.equal(reviewRun.status, "completed");
            yield* sendToThread(context, "review", reviewRun.id, "send:last");
            const sent = sideMessage(
              yield* context.orchestrator.getThreadProjection(source),
              reviewRun.id,
            );
            assert.equal(
              sent[0]?.text,
              "Second opinion from Claude on turn 1:\n\nReview: the change is right.",
            );
          }),
        );
      }),
    ),
  );

  it.effect("a review is sent once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("send-once");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, reviewRunId } = yield* reviewed(context, harness, "Ship it.");
            yield* sendToThread(context, "review", reviewRunId, "send:first");
            const refused = yield* refusal(
              sendToThread(context, "review", reviewRunId, "send:second"),
            );
            assert.equal(refused, ALREADY_SENT);
            yield* sendToThread(context, "review", reviewRunId, "send:first");
            const projection = yield* context.orchestrator.getThreadProjection(source);
            assert.lengthOf(sideMessage(projection, reviewRunId), 1);
            assert.lengthOf(
              projection.runs.filter((run) => run.userMessageId === `side-${reviewRunId}`),
              1,
            );
          }),
        );
      }),
    ),
  );

  it.effect("only a finished second opinion can be sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("send-only-finished");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            const before = yield* context.orchestrator.getThreadProjection(source);

            // A running review run.
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "running-review",
              driver: "claudeAgent",
            });
            const running = (yield* projectionOf(context, "running-review")).runs[0]!;
            harness.script.hold.add(running.userMessageId);
            yield* context.settle;
            assert.equal(
              (yield* projectionOf(context, "running-review")).runs[0]?.status,
              "running",
            );
            assert.equal(
              yield* refusal(sendToThread(context, "running-review", running.id, "send:running")),
              ONLY_FINISHED_REVIEW,
            );

            // A completed review run with no assistant text.
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "silent-review",
              driver: "claudeAgent",
            });
            const silent = (yield* projectionOf(context, "silent-review")).runs[0]!;
            harness.script.silent.add(silent.userMessageId);
            yield* context.settle;
            assert.equal(
              (yield* projectionOf(context, "silent-review")).runs[0]?.status,
              "completed",
            );
            assert.equal(
              yield* refusal(sendToThread(context, "silent-review", silent.id, "send:silent")),
              ONLY_FINISHED_REVIEW,
            );

            // An aside's completed run.
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const asideRun = (yield* projectionOf(context, "aside")).runs[0]!;
            assert.equal(asideRun.status, "completed");
            assert.equal(
              yield* refusal(sendToThread(context, "aside", asideRun.id, "send:aside")),
              ONLY_FINISHED_REVIEW,
            );

            const after = yield* context.orchestrator.getThreadProjection(source);
            assert.deepEqual(after.messages, before.messages);
          }),
        );
      }),
    ),
  );

  it.effect("a source that cannot queue refuses the send", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const noQueue = {
          driver: "noqueue",
          capabilities: {
            ...CodexProviderCapabilitiesV2,
            turns: { ...CodexProviderCapabilitiesV2.turns, supportsQueuedMessages: false },
          },
        };
        const harness = yield* makeHarness("send-no-queue", [noQueue, CLAUDE]);
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "noqueue",
            });
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
            });
            yield* context.settle;
            const reviewRun = (yield* projectionOf(context, "review")).runs[0]!;
            assert.equal(reviewRun.status, "completed");
            harness.script.hold.add("message:source:2");
            yield* context.turn(source, "message:source:2", "busy");
            const before = yield* context.orchestrator.getThreadProjection(source);
            const error = yield* Effect.flip(sendToThread(context, "review", reviewRun.id, "send"));
            assert.equal(refusedCapability(error), "queued_messages");
            assert.equal(
              userFacingDispatchErrorMessage(error),
              "Noqueue cannot queue messages behind an active run.",
            );
            const after = yield* context.orchestrator.getThreadProjection(source);
            assert.lengthOf(sideMessage(after, reviewRun.id), 0);
            assert.deepEqual(after.messages, before.messages);
          }),
        );
      }),
    ),
  );
});

describe("a side thread's limits", () => {
  it.effect("a side thread cannot move to a provider without a read-only run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-cannot-move");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const aside = ThreadId.make("aside");
            const target = selection("antigravity");
            const commands: ReadonlyArray<OrchestrationV2Command> = [
              {
                type: "provider.switch",
                commandId: CommandId.make("switch"),
                threadId: aside,
                modelSelection: target,
              },
              {
                type: "thread.model-selection.set",
                commandId: CommandId.make("model"),
                threadId: aside,
                modelSelection: target,
              },
              {
                type: "message.dispatch",
                commandId: CommandId.make("message-with-model"),
                threadId: aside,
                messageId: MessageId.make("message:moved"),
                text: "on another provider",
                attachments: [],
                modelSelection: target,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              },
            ];
            for (const command of commands) {
              const error = yield* Effect.flip(context.dispatch(command));
              assert.equal(refusedCapability(error), "read_only_run", command.type);
              assert.equal(
                userFacingDispatchErrorMessage(error),
                ANTIGRAVITY_REFUSAL,
                command.type,
              );
            }
            const projection = yield* projectionOf(context, "aside");
            assert.equal(projection.thread.providerInstanceId, "codex");
            assert.isFalse(projection.messages.some((message) => message.id === "message:moved"));
          }),
        );
      }),
    ),
  );

  it.effect("a side thread on an unproven provider never starts a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-unproven");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            // A side thread stored while its provider still declared a read-only run, read by a
            // build whose adapter no longer declares one.
            const eventSink = yield* EventSink.EventSinkV2;
            const sourceThread = (yield* context.orchestrator.getThreadProjection(source)).thread;
            const now = yield* DateTime.now;
            const sideThreadId = ThreadId.make("unproven");
            const sideThread = {
              ...sourceThread,
              id: sideThreadId,
              title: "Second opinion: unproven",
              providerInstanceId: selection("antigravity").instanceId,
              modelSelection: selection("antigravity"),
              activeProviderThreadId: null,
              lineage: {
                rootThreadId: sideThreadId,
                parentThreadId: null,
                relationshipToParent: null,
              },
              forkedFrom: null,
              side: {
                kind: "secondOpinion" as const,
                sourceThreadId: source,
                sourceRunId: firstRunId,
              },
              createdAt: now,
              updatedAt: now,
            };
            yield* eventSink.write({
              events: [
                {
                  id: yield* IdAllocator.IdAllocatorV2.use((ids) =>
                    ids.allocate.event({ threadId: sideThreadId }),
                  ).pipe(Effect.provide(IdAllocator.layer)),
                  type: "thread.created",
                  threadId: sideThreadId,
                  providerInstanceId: sideThread.providerInstanceId,
                  occurredAt: now,
                  payload: sideThread,
                } as OrchestrationV2DomainEvent,
              ],
            });

            const policy = yield* Effect.gen(function* () {
              const resolver = yield* RuntimePolicy.RuntimePolicyV2;
              return yield* Effect.flip(
                resolver.resolve({ thread: sideThread, modelSelection: sideThread.modelSelection }),
              );
            }).pipe(
              Effect.provide(
                RuntimePolicy.layerReadOnlySideThreads.pipe(
                  Layer.provide(RuntimePolicy.layer),
                  Layer.provide(harness.registry),
                  Layer.provide(McpProviderSessions.layer),
                  Layer.provide(layerNoReadOnlyThreads),
                ),
              ),
            );
            assert.equal(policy._tag, "RuntimePolicyResolveError");

            // The run's policy resolves when it is planned, so the message may be refused there.
            const sent = yield* Effect.exit(
              context.send(sideThreadId, "message:unproven", "review this"),
            );
            if (sent._tag === "Failure") {
              assert.include(Cause.pretty(sent.cause), "RuntimePolicyResolveError");
            }
            yield* context.settle;
            assert.isFalse(
              harness.log.started.some((turn) => turn.input.threadId === sideThreadId),
              "no provider turn starts on an unproven provider",
            );
          }),
        );
      }),
    ),
  );

  it.effect("a side thread gets no T3 tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-no-tools");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            yield* startAside(context, { source, aside: "aside" });
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
            });
            yield* context.settle;
            yield* context.turn(ThreadId.make("aside"), "message:aside:2", "more");
            // The source, an ordinary thread, is issued a credential: the control.
            assert.include(harness.log.mcpIssued, source);
            assert.isDefined(
              harness.log.started.find((turn) => turn.input.threadId === source)?.mcp,
            );
            for (const sideThreadId of ["aside", "review"]) {
              assert.notInclude(harness.log.mcpIssued, sideThreadId);
              const turns = harness.log.started.filter(
                (turn) => turn.input.threadId === sideThreadId,
              );
              assert.isAbove(turns.length, 0, sideThreadId);
              for (const turn of turns) assert.isUndefined(turn.mcp, sideThreadId);
            }
          }),
        );
      }),
    ),
  );

  it.effect("a side thread refuses rollback and delegation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-refuses");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            harness.script.hold.add("message:aside");
            yield* startAside(context, { source, aside: "aside" });
            yield* context.settle;
            const aside = yield* projectionOf(context, "aside");
            const run = aside.runs[0]!;
            const checkpoint = aside.checkpoints[0];
            const commands: ReadonlyArray<OrchestrationV2Command> = [
              {
                type: "checkpoint.rollback",
                commandId: CommandId.make("rollback"),
                threadId: aside.thread.id,
                scopeId: checkpoint?.scopeId ?? CheckpointScopeId.make("scope:aside"),
                checkpointId: checkpoint?.id ?? CheckpointId.make("checkpoint:aside"),
              },
              {
                type: "delegated_task.request",
                commandId: CommandId.make("delegate"),
                parentThreadId: aside.thread.id,
                parentRunId: run.id,
                parentNodeId: run.rootNodeId ?? NodeId.make("node:aside"),
                task: "Edit the parser",
                modelSelection: selection("codex"),
                runtimeMode: "full-access",
                interactionMode: "default",
                createdBy: "agent",
                creationSource: "mcp",
              },
            ];
            for (const command of commands) {
              assert.equal(yield* refusal(context.dispatch(command)), SIDE_READ_ONLY, command.type);
            }
            const after = yield* projectionOf(context, "aside");
            assert.lengthOf(after.subagents, 0);
          }),
        );
      }),
    ),
  );

  it.effect("a command on a missing thread keeps upstream's error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-guard-missing");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const missing = ThreadId.make("missing");
            const commands: ReadonlyArray<OrchestrationV2Command> = [
              {
                type: "checkpoint.rollback",
                commandId: CommandId.make("rollback:missing"),
                threadId: missing,
                scopeId: CheckpointScopeId.make("scope:missing"),
                checkpointId: CheckpointId.make("checkpoint:missing"),
              },
              {
                type: "thread.fork",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make("fork:missing"),
                sourceThreadId: missing,
                targetThreadId: ThreadId.make("fork-target"),
                sourcePoint: { type: "run", runId: RunId.make("run:missing") },
              },
              {
                type: "thread.merge_back",
                commandId: CommandId.make("merge-back:missing"),
                sourceThreadId: missing,
                targetThreadId: ThreadId.make("merge-target"),
                sourcePoint: { type: "latest_stable" },
                createdBy: "user",
                creationSource: "web",
              },
              {
                type: "delegated_task.request",
                commandId: CommandId.make("delegate:missing"),
                parentThreadId: missing,
                parentRunId: RunId.make("run:missing"),
                parentNodeId: NodeId.make("node:missing"),
                task: "Edit the parser",
                modelSelection: selection("codex"),
                runtimeMode: "full-access",
                interactionMode: "default",
                createdBy: "agent",
                creationSource: "mcp",
              },
              {
                type: "thread.model-selection.set",
                commandId: CommandId.make("model:missing"),
                threadId: missing,
                modelSelection: selection("codex"),
              },
            ];
            for (const command of commands) {
              const error = yield* Effect.flip(context.dispatch(command));
              // Upstream's handlers report a missing thread with this error; the guard does too.
              assert.equal(
                (error as { readonly _tag: string })._tag,
                "OrchestratorProjectionError",
                command.type,
              );
              assert.equal(
                (error as { readonly message: string }).message,
                "Failed to load orchestration projection for thread missing.",
                command.type,
              );
            }
          }),
        );
      }),
    ),
  );

  it.effect("deleting a source deletes its side threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("side-delete");
        yield* runWith(harness, (context) =>
          Effect.gen(function* () {
            const { source, firstRunId } = yield* sourceWithTurn(context, harness, {
              threadId: "source",
              driver: "codex",
            });
            yield* startAside(context, { source, aside: "aside" });
            yield* requestReview(context, {
              source,
              runId: firstRunId,
              review: "review",
              driver: "claudeAgent",
            });
            yield* context.settle;

            // Deleting an aside leaves the source and its other side thread alone.
            const beforeAside = context.events.length;
            yield* context.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("delete:aside"),
              threadId: ThreadId.make("aside"),
            });
            const asideDeleted = context.events
              .slice(beforeAside)
              .filter((event) => event.type === "thread.deleted");
            assert.deepEqual(
              asideDeleted.map((event) => event.threadId),
              ["aside"],
            );
            assert.isNull(
              (yield* context.orchestrator.getThreadProjection(source)).thread.deletedAt,
            );
            assert.isNull((yield* projectionOf(context, "review")).thread.deletedAt);

            // Deleting the source deletes it and both side threads in one command.
            yield* startAside(context, { source, aside: "aside-2" });
            yield* context.settle;
            const beforeSource = context.events.length;
            yield* context.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("delete:source"),
              threadId: source,
            });
            const deleted = context.events
              .slice(beforeSource)
              .filter((event) => event.type === "thread.deleted")
              .map((event) => event.threadId);
            assert.sameMembers(deleted, [source, "review", "aside-2"]);
            assert.lengthOf(deleted, 3);
          }),
        );
      }),
    ),
  );
});
