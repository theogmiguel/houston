// @effect-diagnostics nodeBuiltinImport:off - reads the toolkit's sources for the verb scan.
// Agents enqueue, dequeue and read only their own project's queue and reach no other verb; the
// queue is real (GitHub fake, real git), only the caller thread lookup is a double.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  createProject,
  git,
  layerMergeQueueTest,
  makeGitHub,
  makeRepos,
  openPull,
  pullUrl,
  pushBranch,
  type FakeGitHub,
} from "../mergeQueue.testkit.ts";
import { HoustonMergeQueueProject } from "../Project.ts";
import { HoustonMergeQueueService } from "../Service.ts";
import { HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL, HoustonMergeQueueToolkit } from "./tools.ts";

const TIMEOUT = 180_000;
const environmentId = EnvironmentId.make("environment-merge-queue-tools");
const TOOLS = [
  "houston_merge_queue_enqueue",
  "houston_merge_queue_dequeue",
  "houston_merge_queue_status",
] as const;
const P_REPOSITORY = "o/r";
const Q_REPOSITORY = "o/q";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "merge-queue-tools", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "merge-queue-tools", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  /** The parsed JSON text: the encoded result or failure. */
  readonly value: any;
}

type QueueServices = HoustonMergeQueueService | HoustonMergeQueueProject;

const textOf = (result: McpSchema.CallToolResult) =>
  (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const scopeOf = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

interface Harness {
  readonly services: Context.Context<QueueServices>;
  readonly shells: Map<string, OrchestrationV2ThreadShell>;
  /** Registers a live caller thread in `projectId` and returns its MCP scope. */
  readonly caller: (
    id: string,
    projectId: ProjectId,
    capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>,
  ) => McpInvocationContext.McpThreadInvocationScope;
}

const harnessOf = Effect.gen(function* () {
  const services = yield* Effect.context<QueueServices>();
  const shells = new Map<string, OrchestrationV2ThreadShell>();
  const caller: Harness["caller"] = (
    id,
    projectId,
    capabilities = ["orchestration", "worktree", "pull-requests"],
  ) => {
    const threadId = ThreadId.make(id);
    shells.set(id, {
      ...liveThreadShell(threadId, { activeRunId: RunId.make(`run-${id}`) }),
      projectId,
    });
    return scopeOf(threadId, capabilities);
  };
  return { services, shells, caller } satisfies Harness;
});

const threadsDouble = (shells: Map<string, OrchestrationV2ThreadShell>) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
  });

const toolkitLayer = (harness: Harness) =>
  McpHttpServer.layerHoustonMergeQueueToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeedContext(harness.services),
        threadsDouble(harness.shells),
        NodeServices.layer,
      ),
    ),
  );

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = (yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.orDie,
      )) as McpSchema.CallToolResult;
    const text = textOf(result);
    const answer: ToolResult = { isError: result.isError === true, text, value: parse(text) };
    return answer;
  });

const succeeded = (result: ToolResult, label: string) =>
  assert.isFalse(result.isError, `${label}: ${result.text}`);

const refused = (result: ToolResult, label: string, ...parts: ReadonlyArray<string>) => {
  assert.isTrue(result.isError, `${label} is refused: ${result.text}`);
  for (const part of parts) assert.include(result.text, part, label);
};

/** A project at a fresh checkout of `github`'s repository whose pull requests `numbers` are open. */
const projectWith = (name: string, github: FakeGitHub, numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (const number of numbers) {
      pushBranch(github.repos!, `houston/${number}`, { [`f${number}.txt`]: `${number}\n` });
      openPull(github, number);
    }
    return yield* createProject(name, github.repos!.checkout);
  });

const numbersOf = (entries: ReadonlyArray<{ readonly number: number }>) =>
  entries.map((entry) => entry.number);

describe("agents enqueue into their own project's queue", () => {
  it.effect(
    "agents enqueue into their own project's queue",
    () => {
      const githubP = makeGitHub(makeRepos("houston-mq-tools-p-", P_REPOSITORY));
      const githubQ = makeGitHub(makeRepos("houston-mq-tools-q-", Q_REPOSITORY));
      return Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectP = yield* projectWith("tools-p", githubP, [12]);
        const projectQ = yield* projectWith("tools-q", githubQ, [5, 12]);
        yield* queue.enqueue({ projectId: projectQ, pullRequest: 5 });
        const harness = yield* harnessOf;
        const agent = harness.caller("thread-T", projectP);

        return yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const names = server.tools.map(({ tool }) => tool.name);
          assert.deepEqual([...names].sort(), [...TOOLS].sort());

          // Enqueue: P's queue, the caller as owner; Q's queue does not move.
          const enqueued = yield* call(agent, "houston_merge_queue_enqueue", { pullRequest: 12 });
          succeeded(enqueued, "enqueue #12");
          assert.strictEqual(enqueued.value.untrusted, HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL);
          assert.strictEqual(enqueued.value.entry.number, 12);
          assert.strictEqual(enqueued.value.entry.ownerThreadId, "thread-T");
          const p = yield* queue.get({ projectId: projectP });
          assert.deepEqual(numbersOf(p.entries), [12]);
          assert.strictEqual(p.entries[0]!.ownerThreadId, "thread-T");
          assert.deepEqual(numbersOf((yield* queue.get({ projectId: projectQ })).entries), [5]);

          // A pull request of Q's repository is refused naming both, and Q's GitHub is not read.
          const qRequests = githubQ.requests.length;
          for (const pullRequest of [pullUrl(5, Q_REPOSITORY), pullUrl(12, Q_REPOSITORY)]) {
            const other = yield* call(agent, "houston_merge_queue_enqueue", { pullRequest });
            refused(other, `enqueue ${pullRequest}`, "refused", Q_REPOSITORY, P_REPOSITORY);
          }
          assert.strictEqual(githubQ.requests.length, qRequests, "Q's repository was not read");
          assert.deepEqual(numbersOf((yield* queue.get({ projectId: projectP })).entries), [12]);
          const q = yield* queue.get({ projectId: projectQ });
          assert.deepEqual(numbersOf(q.entries), [5]);
          assert.isNull(q.entries[0]!.ownerThreadId, "Q's entry keeps the user as its enqueuer");

          // Status: P's entries only, each with place, status, reason and gates.
          const status = yield* call(agent, "houston_merge_queue_status", {});
          succeeded(status, "status");
          assert.strictEqual(status.value.untrusted, HOUSTON_MERGE_QUEUE_UNTRUSTED_LABEL);
          assert.deepEqual(numbersOf(status.value.entries), [12]);
          const [entry] = status.value.entries;
          assert.strictEqual(entry.position, 1);
          assert.isString(entry.status);
          assert.property(entry, "reason");
          assert.deepEqual(
            (entry.gates as ReadonlyArray<{ kind: string }>).map((gate) => gate.kind),
            ["mergeable", "reviewThreads", "reviewer", "verification"],
          );

          // Dequeue: Q's #5 is not P's to remove, by number or by URL.
          const byNumber = yield* call(agent, "houston_merge_queue_dequeue", { pullRequest: 5 });
          refused(byNumber, "dequeue #5", "not_found");
          const byUrl = yield* call(agent, "houston_merge_queue_dequeue", {
            pullRequest: pullUrl(5, Q_REPOSITORY),
          });
          refused(byUrl, "dequeue Q's #5 by URL", "refused", Q_REPOSITORY, P_REPOSITORY);
          assert.deepEqual(numbersOf((yield* queue.get({ projectId: projectQ })).entries), [5]);

          const dequeued = yield* call(agent, "houston_merge_queue_dequeue", {
            pullRequest: pullUrl(12, P_REPOSITORY),
          });
          succeeded(dequeued, "dequeue #12");
          assert.deepEqual((yield* queue.get({ projectId: projectP })).entries, []);
          assert.deepEqual(numbersOf((yield* queue.get({ projectId: projectQ })).entries), [5]);

          // A thread credential without the pull-requests capability reaches no queue.
          const narrow = harness.caller("thread-narrow", projectP, ["orchestration"]);
          for (const [name, args] of [
            ["houston_merge_queue_enqueue", { pullRequest: 12 }],
            ["houston_merge_queue_dequeue", { pullRequest: 5 }],
            ["houston_merge_queue_status", {}],
          ] as const) {
            refused(
              yield* call(narrow, name, args),
              `${name} without pull-requests`,
              "pull-requests",
            );
          }
          assert.deepEqual((yield* queue.get({ projectId: projectP })).entries, []);

          // A project without a GitHub remote has no queue for its agents.
          const gitlab = makeRepos("houston-mq-tools-gitlab-");
          git(gitlab.checkout, ["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
          const gitlabProject = yield* createProject("tools-gitlab", gitlab.checkout);
          const gitlabAgent = harness.caller("thread-gitlab", gitlabProject);
          refused(
            yield* call(gitlabAgent, "houston_merge_queue_status", {}),
            "status on GitLab",
            "unsupported",
            "the merge queue needs a GitHub remote",
          );
        }).pipe(Effect.provide(toolkitLayer(harness)));
      }).pipe(
        Effect.provide(
          Layer.fresh(layerMergeQueueTest({ github: [githubP, githubQ], loops: false })),
        ),
      );
    },
    TIMEOUT,
  );

  it.effect(
    "agents enqueue into their own project's queue: over /mcp with the thread's bearer credential",
    () => {
      const github = makeGitHub(makeRepos("houston-mq-tools-http-", P_REPOSITORY));
      return Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* projectWith("tools-http", github, [7]);
        const harness = yield* harnessOf;
        const agent = harness.caller("thread-http", projectId);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const serverLayer = McpHttpServer.layerHoustonMergeQueueToolkit.pipe(
              Layer.provideMerge(
                McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
              ),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeedContext(harness.services),
                  threadsDouble(harness.shells),
                  Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                    resolve: (token) =>
                      Effect.succeed(token === "thread-http-token" ? agent : undefined),
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
            const body = (id: number, method: string, params: unknown) =>
              HttpBody.text(
                JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                "application/json",
              );
            const enqueueCall = body(2, "tools/call", {
              name: "houston_merge_queue_enqueue",
              arguments: { pullRequest: 7 },
            });

            for (const authorization of [undefined, "Bearer not-a-houston-token"]) {
              const response = yield* http.post("/mcp", {
                headers: {
                  accept: "application/json, text/event-stream",
                  ...(authorization === undefined ? {} : { authorization }),
                },
                body: enqueueCall,
              });
              assert.strictEqual(response.status, 401, `authorization ${authorization}`);
            }
            assert.deepEqual((yield* queue.get({ projectId })).entries, []);

            const headers = {
              accept: "application/json, text/event-stream",
              authorization: "Bearer thread-http-token",
            };
            const initialize = yield* http.post("/mcp", {
              headers,
              body: body(1, "initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "agent", version: "1.0.0" },
              }),
            });
            assert.strictEqual(initialize.status, 200);
            const session = {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            };
            const answer = yield* http
              .post("/mcp", { headers: session, body: enqueueCall })
              .pipe(Effect.flatMap((response) => response.text));
            assert.notInclude(answer, '"isError":true', answer);
            const entries = (yield* queue.get({ projectId })).entries;
            assert.deepEqual(numbersOf(entries), [7]);
            assert.strictEqual(entries[0]!.ownerThreadId, "thread-http");
          }),
        ).pipe(Effect.provide(NodeHttpServer.layerTest));
      }).pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, loops: false }))));
    },
    TIMEOUT,
  );
});

/** The queue verbs an agent must never reach, by the service method that performs each. */
const FORBIDDEN_VERBS = [
  "mergeHead",
  "setSettings",
  "pause",
  "retry",
  "revert",
  "handToThread",
  "acknowledge",
] as const;

describe("the toolkit offers no merge, push or settings tool", () => {
  it.effect(
    "the toolkit offers no merge, push or settings tool",
    () => {
      const github = makeGitHub(makeRepos("houston-mq-tools-verbs-", P_REPOSITORY));
      return Effect.gen(function* () {
        const queue = yield* HoustonMergeQueueService;
        const projectId = yield* projectWith("tools-verbs", github, [3]);
        yield* queue.enqueue({ projectId, pullRequest: 3 });
        const harness = yield* harnessOf;
        const agent = harness.caller("thread-verbs", projectId);

        assert.deepEqual(Object.keys(HoustonMergeQueueToolkit.tools).sort(), [...TOOLS].sort());

        return yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const names = server.tools.map(({ tool }) => tool.name);
          assert.deepEqual([...names].sort(), [...TOOLS].sort());
          for (const name of names) {
            assert.notMatch(
              name,
              /merge_queue_(merge|push|retry|pause|resume|revert|settings|hand|acknowledge)/,
              name,
            );
          }

          const before = yield* queue.get({ projectId });
          for (const name of [
            "houston_merge_queue_merge",
            "houston_merge_queue_merge_head",
            "houston_merge_queue_push",
            "houston_merge_queue_retry",
            "houston_merge_queue_pause",
            "houston_merge_queue_revert",
            "houston_merge_queue_settings_set",
          ]) {
            const result = yield* call(agent, name, {
              pullRequest: 3,
              number: 3,
              expectedHeadSha: before.entries[0]!.headSha,
              paused: true,
            }).pipe(
              Effect.catchCause(() =>
                Effect.succeed({ isError: true, text: "unknown tool", value: undefined }),
              ),
            );
            assert.isTrue(result.isError, `${name} is not a tool: ${result.text}`);
          }
          const after = yield* queue.get({ projectId });
          assert.deepEqual(after.entries, before.entries, "no refused name changed the queue");
          assert.deepEqual(after.settings, before.settings);
          assert.deepEqual(after.log, []);
          assert.deepEqual(
            github.requests.filter((request) => request.method === "PUT"),
            [],
            "no merge request reached GitHub",
          );

          // Static: the toolkit's sources call none of the queue's merge, settings or valve verbs.
          const directory = import.meta.dirname;
          for (const file of NodeFS.readdirSync(directory)) {
            if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
            const source = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
            for (const verb of FORBIDDEN_VERBS) {
              assert.notMatch(source, new RegExp(`\\.${verb}\\s*\\(`), `${file} calls ${verb}`);
            }
            assert.notMatch(
              source,
              /\bpush\s*\(|--force|GitHubQueueClient|HoustonMergeLanding/,
              file,
            );
          }
        }).pipe(Effect.provide(toolkitLayer(harness)));
      }).pipe(Effect.provide(Layer.fresh(layerMergeQueueTest({ github, loops: false }))));
    },
    TIMEOUT,
  );
});
