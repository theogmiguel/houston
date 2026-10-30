// OpenCode 1 has no inbox: an assistant reply whose parentID is the steer's own message is the
// provider's link to it. Driven with an in-test SDK client, as adapter.test.ts drives admission.
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OpenCodeSettings } from "../../settings.ts";
import { makeOpenCodeAdapterV2 } from "../adapter.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";

const SETTINGS = Schema.decodeSync(OpenCodeSettings)({ serverUrl: "http://test.invalid" });
const SESSION = "native-opencode-steer";

function nativeEventStream() {
  const queued: Array<unknown> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else queued.push(value);
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift() });
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

// The SDK client hands events over through promises; let the adapter drain them.
const settleEvents = Effect.forEach(
  Array.from({ length: 200 }),
  () => Effect.promise(() => Promise.resolve()).pipe(Effect.andThen(Effect.yieldNow)),
  { discard: true },
);

describe("OpenCode 1 steer delivery", () => {
  it.live("an OpenCode 1 reply to the steer adopts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = nativeEventStream();
        const prompts: Array<{ readonly messageID?: string }> = [];
        const client = {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => native.close(), { once: true });
              return { stream: native.stream };
            },
          },
          session: {
            create: async () => ({ data: { id: SESSION, time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: SESSION, time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: { readonly messageID?: string }) => {
              prompts.push(input);
              return { data: true };
            },
            status: async () => ({ data: { [SESSION]: { type: "busy" } } }),
            messages: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            abort: async () => ({ data: true }),
          },
          mcp: { add: async () => ({ data: true }) },
        };
        const adapter = yield* makeOpenCodeAdapterV2({
          instanceId: ProviderInstanceId.make("opencode-test"),
          settings: SETTINGS,
          environment: {},
        }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
            connectToOpenCodeServer: () =>
              Effect.succeed({ url: "http://test.invalid", external: true }),
            createOpenCodeSdkClient: () => client,
          } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
          Effect.provideService(ProviderHost.ProviderHost, {
            paths: { cwd: "/workspace" },
            resolveAttachmentPath: () => null,
          } as unknown as ProviderHost.ProviderHost["Service"]),
        );
        const threadId = ThreadId.make("thread-opencode-steer");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("opencode-test"),
          model: "anthropic/claude-sonnet",
          options: [],
        };
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-opencode-steer"),
          modelSelection,
          runtimePolicy: policy,
        });
        const emitted: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => emitted.push(event))),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: policy,
        });
        const now = yield* DateTime.now;
        const created = DateTime.toEpochMillis(now);
        const userMessage = (id: string) => ({
          type: "message.updated",
          properties: {
            sessionID: SESSION,
            info: { id, sessionID: SESSION, role: "user", time: { created } },
          },
        });
        const assistantReply = (id: string, parentID: string) => ({
          type: "message.updated",
          properties: {
            sessionID: SESSION,
            info: { id, sessionID: SESSION, role: "assistant", parentID, time: { created } },
          },
        });
        const runId = RunId.make("run-opencode-steer");
        yield* runtime
          .startTurn({
            appThread: {
              id: threadId,
              projectId: ProjectId.make("project-opencode-steer"),
              title: "steer",
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-opencode-steer"),
            rootNodeId: NodeId.make("node-opencode-steer"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-opencode-first"),
              text: "hello",
              attachments: [],
            },
            modelSelection,
            runtimePolicy: policy,
          })
          .pipe(Effect.forkScoped);
        yield* settleEvents;
        native.push({
          type: "session.status",
          properties: { sessionID: SESSION, status: { type: "busy" } },
        });
        native.push(userMessage(prompts[0]!.messageID!));
        yield* settleEvents;
        const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
        const activeTurn = snapshot.providerTurns.at(-1)!;
        assert.equal(activeTurn.status, "running");

        const steerMessageId = MessageId.make("message-opencode-steer");
        const receipt = yield* runtime.steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: steerMessageId,
            text: "follow up",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        assert.deepEqual(receipt, { adoption: "reported" });
        const steerNativeId = prompts[1]!.messageID!;
        native.push(userMessage(steerNativeId));
        // A reply to the turn's first prompt is not a reply to the steer.
        native.push(assistantReply("msg_reply_first", prompts[0]!.messageID!));
        yield* settleEvents;
        const deliveries = () => emitted.filter((event) => event.type === "message.delivery");
        assert.lengthOf(deliveries(), 0);

        native.push(assistantReply("msg_reply_steer", steerNativeId));
        yield* settleEvents;
        assert.lengthOf(deliveries(), 1);
        assert.deepInclude(deliveries()[0], {
          type: "message.delivery",
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId: activeTurn.id,
          messageId: steerMessageId,
          state: "adopted",
          evidence: "opencode.replyParent",
        });
        // A second reply to the same steer reports nothing new.
        native.push(assistantReply("msg_reply_steer_2", steerNativeId));
        yield* settleEvents;
        assert.lengthOf(deliveries(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );
});
