// The houston_slack_* tools, called as the thread of a Slack-filed run and as other threads,
// over the Slack test layers. Only the caller thread lookup is a double.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { HoustonTaskRuns } from "../../tasks/TaskRuns.ts";
import { HoustonTaskService } from "../../tasks/TaskService.ts";
import { refuse as refuseTask } from "../../tasks/rules.ts";
import { HoustonSlackConversation } from "../Conversation.ts";
import type { SlackFake } from "../slack.fake.ts";
import {
  advance,
  buttonsOf,
  connectedProject,
  flushOutbox,
  makeFakeRuns,
  ownerDms,
  postedText,
  replyEvent,
  runSlack,
  sendEvent,
  startedRequest,
  storedRequest,
  threadPosts,
  tickReplies,
  until,
  type FakeRuns,
} from "../slack.testkit.ts";

const environmentId = EnvironmentId.make("environment-slack-tools");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "slack-tools", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "slack-tools", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const scopeOf = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
});

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly value: any;
}

const textOf = (result: McpSchema.CallToolResult) =>
  (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const shells = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
});

const toolkitLayer = (services: Context.Context<HoustonSlackConversation>) =>
  McpHttpServer.layerHoustonSlackToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.mergeAll(Layer.succeedContext(services), shells, NodeServices.layer)),
  );

const call = (threadId: string, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = (yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.orDie,
      )) as McpSchema.CallToolResult;
    const text = textOf(result);
    return { isError: result.isError === true, text, value: parse(text) } satisfies ToolResult;
  });

/** Runs `body` over the Slack layers with the toolkit registered. */
const withTools = <A, E, R>(
  body: (fake: SlackFake) => Effect.Effect<A, E, R>,
  options: { readonly runs?: FakeRuns; readonly startAtMs?: number } = {},
) =>
  runSlack(
    (fake) =>
      Effect.gen(function* () {
        const services = yield* Effect.context<HoustonSlackConversation>();
        return yield* (body(fake) as Effect.Effect<A, E, never>).pipe(
          Effect.provide(toolkitLayer(services)),
        );
      }),
    options,
  );

const refused = (result: ToolResult, label: string) => {
  assert.isTrue(result.isError, `${label} is refused: ${result.text}`);
  return result.value as {
    readonly _tag: string;
    readonly kind: string;
    readonly field?: string;
    readonly limit?: number;
    readonly actual?: number;
    readonly message: string;
  };
};

const ASK = {
  context: "The report exports nightly.",
  question: "Which format should the export use?",
  options: ["CSV", "JSON", "Both"],
  recommended: 1,
  why: "JSON keeps the types.",
};

const READY = {
  outcome: "ready",
  subject: "Export works",
  changes: "The report exports CSV.",
  steps: ["Open Reports and click Export"],
  size: "small",
  notes: ["Ran the export test"],
  warnings: ["The CSV has no header row"],
  liveNote: "It is live.",
  droppedNote: "It was dropped.",
};

/** A task the user filed in Houston and started: its run's thread is not a Slack run. */
const houstonRun = Effect.gen(function* () {
  const tasks = yield* HoustonTaskService;
  const runs = yield* HoustonTaskRuns;
  const projectId = (yield* tasks.get({ id: "1" })).task.projectId;
  const task = yield* tasks.save({
    patch: { title: "Made in Houston", projectId, status: "todo", acceptance: ["done"] },
  });
  const started = yield* runs.start({ id: task.key });
  return started.run.threadId as string;
});

describe("a question has a button per option and is refused outside a slack run", () => {
  it.effect("a question has a button per option and is refused outside a slack run", () =>
    withTools((fake) =>
      Effect.gen(function* () {
        yield* connectedProject("ask");
        const ts = "1700000000.000100";
        const request = yield* startedRequest(fake, ts, "Export the report");
        yield* flushOutbox;

        const bounds: ReadonlyArray<{
          readonly patch: Record<string, unknown>;
          readonly kind: string;
          readonly field: string;
          readonly limit?: number;
          readonly actual?: number;
        }> = [
          { patch: { context: "c".repeat(501) }, kind: "limit", field: "context", limit: 500, actual: 501 },
          { patch: { question: "q".repeat(301) }, kind: "limit", field: "question", limit: 300, actual: 301 },
          { patch: { options: ["CSV", "o".repeat(201)] }, kind: "limit", field: "options", limit: 200, actual: 201 },
          { patch: { options: ["CSV"] }, kind: "invalid", field: "options" },
          { patch: { options: ["a", "b", "c", "d", "e"] }, kind: "limit", field: "options", limit: 4, actual: 5 },
        ];
        for (const entry of bounds) {
          const label = JSON.stringify(entry.patch).slice(0, 40);
          const refusal = refused(
            yield* call(request.threadId, "houston_slack_ask", { ...ASK, ...entry.patch }),
            label,
          );
          assert.strictEqual(refusal._tag, "HoustonSlackError", label);
          assert.strictEqual(refusal.kind, entry.kind, label);
          assert.strictEqual(refusal.field, entry.field, label);
          if (entry.limit !== undefined) {
            assert.strictEqual(refusal.limit, entry.limit, label);
            assert.strictEqual(refusal.actual, entry.actual, label);
          }
        }
        const sql = yield* SqlClient.SqlClient;
        const [none] = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_slack_questions
        `;
        assert.strictEqual(none?.n, 0, "a refused question records nothing");

        const asked = yield* call(request.threadId, "houston_slack_ask", ASK);
        assert.isFalse(asked.isError, asked.text);
        const questionId = asked.value.questionId as number;
        assert.isNumber(questionId);
        assert.strictEqual((yield* storedRequest(ts))?.status_reaction, "question");
        yield* flushOutbox;
        const posts = threadPosts(fake, ts);
        assert.lengthOf(posts, 1);
        const post = posts[0];
        const text = postedText(post);
        for (const part of ["Which format should the export use?", "CSV", "JSON", "Both"]) {
          assert.include(text, part);
        }
        const buttons = buttonsOf(post);
        assert.lengthOf(buttons, 4);
        assert.strictEqual(buttons[3]?.text.text, "Another answer…");
        assert.deepEqual(
          buttons.map((button) => button.style === "primary"),
          [false, true, false, false],
          "the recommended option is marked",
        );
        assert.include(buttons[1]?.text.text ?? "", "JSON");
        assert.deepEqual(
          fake.callsOf("reactions.add").at(-1)?.body.name,
          "question",
          "the status reaction moves to question",
        );

        const busy = refused(yield* call(request.threadId, "houston_slack_ask", ASK), "busy");
        assert.strictEqual(busy.kind, "busy");

        const other = yield* houstonRun;
        for (const tool of ["houston_slack_ask", "houston_slack_handback"]) {
          const args = tool === "houston_slack_ask" ? ASK : READY;
          const outside = refused(yield* call(other, tool, args), `${tool} from another task`);
          assert.strictEqual(outside.kind, "not_slack", tool);
          const stranger = refused(yield* call("thread-unknown", tool, args), `${tool} unknown`);
          assert.strictEqual(stranger.kind, "not_slack", tool);
        }
      }),
    ),
  );
});

describe("a hand-back goes to the thread and the owner", () => {
  it.effect("a hand-back goes to the thread and the owner", () => {
    const runs = makeFakeRuns();
    runs.prUrl = "https://github.com/acme/shop/pull/7";
    return withTools(
      (fake) =>
        Effect.gen(function* () {
          yield* connectedProject("handback");
          const ts = "1700000000.000100";
          const request = yield* startedRequest(fake, ts, "Export the report");

          // A question waits 4 minutes for its answer.
          const asked = yield* call(request.threadId, "houston_slack_ask", ASK);
          assert.isFalse(asked.isError, asked.text);
          yield* advance(240);
          yield* sendEvent(fake, replyEvent("1700000300.000100", ts, "U2", "CSV please"));
          const sql = yield* SqlClient.SqlClient;
          yield* until(
            "the answer",
            sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM houston_slack_questions WHERE answered_at IS NOT NULL
            `.pipe(Effect.map((rows) => rows[0]?.n === 1)),
          );
          yield* advance(360);

          const bounds: ReadonlyArray<{ readonly patch: Record<string, unknown>; readonly field: string }> = [
            { patch: { subject: "s".repeat(61) }, field: "subject" },
            { patch: { changes: "c".repeat(1_501) }, field: "changes" },
            { patch: { steps: ["a", "b", "c", "d"] }, field: "steps" },
            { patch: { warnings: Array.from({ length: 7 }, (_, n) => `warning ${n}`) }, field: "warnings" },
          ];
          for (const entry of bounds) {
            const refusal = refused(
              yield* call(request.threadId, "houston_slack_handback", { ...READY, ...entry.patch }),
              entry.field,
            );
            assert.strictEqual(refusal.kind, "limit", entry.field);
            assert.strictEqual(refusal.field, entry.field);
          }
          assert.lengthOf(runs.handbacks, 0, "a refused form hands nothing back");

          const handed = yield* call(request.threadId, "houston_slack_handback", READY);
          assert.isFalse(handed.isError, handed.text);
          assert.strictEqual(handed.value.status, "in_review");
          assert.deepEqual(runs.handbacks, [
            { id: request.key, summary: "Export works\n\nThe report exports CSV." },
          ]);
          const [result] = yield* sql<{ readonly task_run_id: number; readonly form_json: string }>`
            SELECT task_run_id, form_json FROM houston_slack_results
          `;
          assert.strictEqual(result?.task_run_id, request.runId);
          assert.include(result?.form_json ?? "", "Export works");

          yield* tickReplies;
          yield* flushOutbox;
          const ready = threadPosts(fake, ts).filter((post) =>
            postedText(post).includes("Ready, waiting for review"),
          );
          assert.lengthOf(ready, 1);
          const thread = postedText(ready[0]);
          assert.include(thread, "Export works");
          assert.include(thread, "Open Reports and click Export");
          for (const hidden of [request.key, `houston/task-${request.taskId}`, "Ran the export test"]) {
            assert.notInclude(thread, hidden);
          }
          assert.include(
            fake.callsOf("reactions.add").map((entry) => entry.body.name),
            "checkered_flag",
          );
          assert.strictEqual((yield* storedRequest(ts))?.status_reaction, "checkered_flag");

          const dm = ownerDms(fake).find((post) => postedText(post).includes("Export works"));
          assert.isDefined(dm, "the owner hears of the hand-back");
          const owner = postedText(dm);
          for (const part of [
            "small",
            `houston/task-${request.taskId}`,
            "https://github.com/acme/shop/pull/7",
            "The CSV has no header row",
            "Ran the export test",
            "6 min",
          ]) {
            assert.include(owner, part);
          }

          // A second tick posts nothing more.
          const before = fake.callsOf("chat.postMessage").length;
          yield* tickReplies;
          yield* flushOutbox;
          assert.strictEqual(fake.callsOf("chat.postMessage").length, before);
        }),
      { runs, startAtMs: Date.UTC(2026, 9, 31, 12) },
    );
  });
});

describe("slack tools need an mcp credential and pass task errors through", () => {
  it.effect("slack tools need an mcp credential and pass task errors through", () => {
    const runs = makeFakeRuns();
    return withTools(
      (fake) =>
        Effect.gen(function* () {
          yield* connectedProject("door");
          const services = yield* Effect.context<HoustonSlackConversation>();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const serverLayer = McpHttpServer.layerHoustonSlackToolkit.pipe(
                Layer.provideMerge(
                  McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
                ),
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeedContext(services),
                    shells,
                    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                      // @effect-diagnostics-next-line effectSucceedWithVoid:off - no token resolves.
                      resolve: () => Effect.succeed(undefined),
                    }),
                    NodeServices.layer,
                  ),
                ),
              );
              yield* HttpRouter.serve(serverLayer, {
                disableListenLog: true,
                disableLogger: true,
              }).pipe(Layer.build);
              const http = yield* HttpClient.HttpClient;
              for (const tool of ["houston_slack_ask", "houston_slack_handback"]) {
                const body = HttpBody.text(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: tool, arguments: tool === "houston_slack_ask" ? ASK : READY },
                  }),
                  "application/json",
                );
                for (const authorization of [undefined, "Bearer not-a-houston-token"]) {
                  const response = yield* http.post("/mcp", {
                    headers: {
                      accept: "application/json, text/event-stream",
                      ...(authorization === undefined ? {} : { authorization }),
                    },
                    body,
                  });
                  assert.strictEqual(response.status, 401, `${tool} ${authorization}`);
                }
              }
            }).pipe(Effect.provide(NodeHttpServer.layerTest)),
          );

          const ts = "1700000000.000100";
          const request = yield* startedRequest(fake, ts, "Export the report");
          runs.handbackFail = refuseTask(
            "conflict",
            "houston.tasks.handback",
            `${request.key} changed since it was read`,
          );
          const failed = refused(
            yield* call(request.threadId, "houston_slack_handback", READY),
            "a conflicting hand-back",
          );
          assert.strictEqual(failed._tag, "HoustonTaskError");
          assert.strictEqual(failed.kind, "conflict");
          assert.include(failed.message, "changed since it was read");
          const sql = yield* SqlClient.SqlClient;
          const [results] = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM houston_slack_results
          `;
          assert.strictEqual(results?.n, 0, "a refused hand-back records no form");
          yield* flushOutbox;
          assert.isFalse(
            threadPosts(fake, ts).some((post) => postedText(post).includes("Ready")),
            "nothing reaches the thread",
          );
        }),
      { runs },
    );
  });
});
