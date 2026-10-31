// The houston_task_* tools: reads cover every project, access is checked on every call, writes
// stay in the caller's project. Task services are real (taskRuns.testkit.ts); only the caller
// thread lookup is a double, so each test names the caller's project, title and kind.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderInstanceId,
  type ProviderInteractionMode,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type {
  HoustonTask,
  HoustonTaskAccess,
  HoustonTaskDetail,
  HoustonTaskError,
} from "@t3tools/contracts/houston/tasks";
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
import { HoustonTaskRuns } from "../TaskRuns.ts";
import { HoustonTaskService } from "../TaskService.ts";
import {
  commitLines,
  makeRunsHarness,
  runWith,
  selection,
  type RunsContext,
} from "../taskRuns.testkit.ts";
import { createProject } from "../tasks.testkit.ts";
import { HOUSTON_TASK_UNTRUSTED_LABEL } from "./tools.ts";

const TIMEOUT = 180_000;
const environmentId = EnvironmentId.make("environment-task-tools");
const ACCESS_SETTING = "Settings ▸ Tasks ▸ Agent access";
const OTHER_WORKSPACE = "tasks of another workspace are read-only to agents";

const READ_TOOLS = ["houston_task_list", "houston_task_get", "houston_task_next"] as const;
const WRITE_TOOLS = [
  "houston_task_create",
  "houston_task_update",
  "houston_task_comment",
  "houston_task_check",
  "houston_task_claim",
  "houston_task_handback",
  "houston_task_plan_submit",
  "houston_task_review_submit",
  "houston_task_execute",
  "houston_task_review",
] as const;
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const SUBMIT_TOOLS = ["houston_task_plan_submit", "houston_task_review_submit"];

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "task-tools", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "task-tools", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

interface CallerOptions {
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
  readonly side?: boolean;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

interface ToolResult {
  readonly isError: boolean;
  readonly text: string;
  /** The parsed JSON text: the encoded result or failure. */
  readonly value: any;
}

type TaskServices = HoustonTaskService | HoustonTaskRuns;

interface ToolkitContext extends RunsContext {
  readonly otherProjectId: ProjectId;
  readonly services: Context.Context<TaskServices>;
  /** Registers a live caller thread and returns its MCP scope. */
  readonly caller: (id: string, options: CallerOptions) => McpInvocationContext.McpInvocationScope;
  readonly rename: (id: string, title: string) => void;
  readonly call: (
    scope: McpInvocationContext.McpInvocationScope,
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<ToolResult, never, McpServer.McpServer>;
  readonly detail: (
    task: Pick<HoustonTask, "key">,
  ) => Effect.Effect<HoustonTaskDetail, HoustonTaskError>;
  readonly setAccess: (access: HoustonTaskAccess) => Effect.Effect<void, HoustonTaskError>;
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

const scopeOf = (
  threadId: ThreadId,
  options: Pick<CallerOptions, "capabilities" | "subagent">,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    ...(options.subagent === true ? { subagent: true } : {}),
  },
  client: undefined,
  capabilities: new Set(options.capabilities ?? ["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
});

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client-read-only",
  thread: undefined,
  client: { sessionId: "client-read-only", label: "Read-only client", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const toolkitLayer = (
  services: Context.Context<TaskServices>,
  shells: Map<string, OrchestrationV2ThreadShell>,
) =>
  McpHttpServer.layerHoustonTaskToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeedContext(services),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
        NodeServices.layer,
      ),
    ),
  );

/** One harness per test: project A is the runs context's, project B another one. */
const withToolkit = <A, E>(
  name: string,
  body: (context: ToolkitContext) => Effect.Effect<A, E, McpServer.McpServer>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeRunsHarness(`toolkit-${name}`);
    return yield* runWith(harness, (context) =>
      Effect.gen(function* () {
        const shells = new Map<string, OrchestrationV2ThreadShell>();
        const services = yield* Effect.context<TaskServices>();
        const otherProjectId = yield* createProject(`toolkit-${name}-other`);
        const caller: ToolkitContext["caller"] = (id, options) => {
          const threadId = ThreadId.make(id);
          const shell = liveThreadShell(threadId, {
            activeRunId: RunId.make(`run-${id}`),
            ...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
            ...(options.interactionMode === undefined
              ? {}
              : { interactionMode: options.interactionMode }),
          });
          shells.set(id, {
            ...shell,
            projectId: options.projectId,
            title: options.title ?? id,
            ...(options.side === true
              ? {
                  side: {
                    kind: "aside" as const,
                    sourceThreadId: ThreadId.make("thread-source"),
                    sourceRunId: RunId.make("run-source"),
                  },
                }
              : {}),
          });
          return scopeOf(threadId, options);
        };
        const rename: ToolkitContext["rename"] = (id, title) => {
          const shell = shells.get(id);
          if (shell !== undefined) shells.set(id, { ...shell, title });
        };
        const call: ToolkitContext["call"] = (scope, toolName, args) =>
          Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const result = (yield* server
              .callTool({ name: toolName, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, client),
                Effect.orDie,
              )) as McpSchema.CallToolResult;
            const text = textOf(result);
            return { isError: result.isError === true, text, value: parse(text) };
          });
        const setAccess: ToolkitContext["setAccess"] = (access) =>
          context.setSettings({ access, reviewer: selection("codex"), reviewMode: "manual" });
        return yield* body({
          ...context,
          otherProjectId,
          services,
          caller,
          rename,
          call,
          detail: (task) => context.tasks.get({ id: task.key }),
          setAccess,
        }).pipe(Effect.provide(toolkitLayer(services, shells)));
      }),
    );
  });

const succeeded = (result: ToolResult, label: string) =>
  assert.isFalse(result.isError, `${label}: ${result.text}`);

const refused = (result: ToolResult, label: string, ...parts: ReadonlyArray<string>) => {
  assert.isTrue(result.isError, `${label} is refused: ${result.text}`);
  for (const part of parts) assert.include(result.text, part, label);
};

describe("task tools read every project", () => {
  it.effect(
    "a thread lists the 13 tools and reads tasks of another project and unassigned ones",
    () =>
      withToolkit("read-every-project", (context) =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const names = server.tools
            .map(({ tool }) => tool.name)
            .filter((name) => name.startsWith("houston_task_"));
          assert.deepEqual([...names].sort(), [...ALL_TOOLS].sort());

          const own = yield* context.tasks.save({
            patch: { title: "Own backlog task", projectId: context.projectId },
          });
          const other = yield* context.tasks.save({
            patch: {
              title: "Other project task",
              status: "todo",
              priority: "urgent",
              acceptance: ["it works"],
              projectId: context.otherProjectId,
            },
          });
          const unassigned = yield* context.tasks.save({
            patch: { title: "Unassigned task", projectId: null },
          });
          const agent = context.caller("agent-a", { projectId: context.projectId });

          const listed = yield* context.call(agent, "houston_task_list", {});
          succeeded(listed, "list");
          const keys = (listed.value.tasks as ReadonlyArray<{ key: string }>).map(
            (task) => task.key,
          );
          for (const task of [own, other, unassigned]) assert.include(keys, task.key);

          for (const task of [other, unassigned]) {
            const read = yield* context.call(agent, "houston_task_get", { id: task.key });
            succeeded(read, `get ${task.key}`);
            assert.strictEqual(read.value.task.key, task.key);
          }

          const next = yield* context.call(agent, "houston_task_next", {});
          succeeded(next, "next");
          assert.strictEqual(next.value.task?.key, other.key, "the only ready task, in project B");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "a call without a thread credential is refused at the MCP door",
    () =>
      withToolkit("mcp-door", (context) =>
        Effect.scoped(
          Effect.gen(function* () {
            const serverLayer = McpHttpServer.layerHoustonTaskToolkit.pipe(
              Layer.provideMerge(
                McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
              ),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeedContext(context.services),
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                  }),
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
            const body = HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"houston_task_list","arguments":{}}}`,
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
              assert.strictEqual(response.status, 401, `authorization ${authorization}`);
            }

            // A signed-in client outside a thread has no project to act for.
            const outside = yield* context.call(
              { ...readOnlyClient, client: { ...readOnlyClient.client!, access: "full-access" } },
              "houston_task_list",
              {},
            );
            refused(outside, "list outside a thread", "thread_credential_required");
          }),
        ).pipe(Effect.provide(NodeHttpServer.layerTest)),
      ),
    TIMEOUT,
  );
});

describe("a submit-only credential reaches only the two submit tools of the registered toolkit", () => {
  it.effect(
    "over /mcp every other houston_task_* tool is refused before its handler runs",
    () =>
      withToolkit("submit-only-door", (context) =>
        Effect.scoped(
          Effect.gen(function* () {
            const task = yield* context.readyTask("Submit-only target");
            const planner = context.caller("task-plan-unrecorded", {
              projectId: context.projectId,
              capabilities: ["houston-task-submit"],
            });
            const plannerShell = liveThreadShell(ThreadId.make("task-plan-unrecorded"), {
              activeRunId: RunId.make("run-planner"),
            });
            const serverLayer = McpHttpServer.layerHoustonTaskToolkit.pipe(
              Layer.provideMerge(
                McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
              ),
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeedContext(context.services),
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getThreadShell: () =>
                      Effect.succeed({ ...plannerShell, projectId: context.projectId }),
                  }),
                  Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                    resolve: (token) =>
                      Effect.succeed(
                        token === "submit-only"
                          ? (planner as McpInvocationContext.McpThreadInvocationScope)
                          : undefined,
                      ),
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
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: "Bearer submit-only",
            };
            const initialize = yield* http.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"planner","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            assert.strictEqual(initialize.status, 200);
            const before = yield* context.detail(task);
            let id = 1;
            const call = (name: string, args: Record<string, unknown>) =>
              http
                .post("/mcp", {
                  headers: {
                    ...headers,
                    "mcp-session-id": initialize.headers["mcp-session-id"]!,
                    "mcp-protocol-version": "2025-06-18",
                  },
                  body: HttpBody.text(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: (id += 1),
                      method: "tools/call",
                      params: { name, arguments: args },
                    }),
                    "application/json",
                  ),
                })
                .pipe(Effect.flatMap((response) => response.text));
            for (const name of ALL_TOOLS.filter((tool) => !SUBMIT_TOOLS.includes(tool))) {
              const text = yield* call(name, {
                id: task.key,
                title: "Changed by a planner",
                body: "a planner comment",
              });
              assert.include(text, "capability_denied", name);
            }
            const after = yield* context.detail(task);
            assert.deepEqual(after.task, before.task, "no refused tool changed the task");
            assert.strictEqual(after.comments.length, before.comments.length);

            const submitted = yield* call("houston_task_plan_submit", {
              id: task.key,
              proposal: {
                description: "planned",
                acceptance: ["it works"],
                pointers: [],
                outOfScope: [],
                questions: [],
              },
            });
            assert.notInclude(submitted, "capability_denied");
            assert.include(submitted, "no recorded planning session", "the submit ran");
            const reviewed = yield* call("houston_task_review_submit", {
              runId: 999,
              verdict: "pass",
              findings: [],
            });
            assert.notInclude(reviewed, "capability_denied");
            assert.include(reviewed, "no recorded review session", "the submit ran");
          }),
        ).pipe(Effect.provide(NodeHttpServer.layerTest)),
      ),
    TIMEOUT,
  );
});

/** A planner and a reviewer the user started, each recorded and holding the submit-only scope. */
const recordedSubmitters = (context: ToolkitContext, name: string) =>
  Effect.gen(function* () {
    const initiative = yield* context.tasks.saveInitiative({
      projectId: context.projectId,
      name: `Initiative ${name}`,
    });
    const plannable = yield* context.readyTask(`Plan me ${name}`);
    yield* context.tasks.saveDomain({
      id: plannable.key,
      expectedRevision: plannable.revision,
      kind: "delivery",
      initiativeId: initiative.id,
    });
    const planned = yield* context.runs.planStart({
      id: plannable.key,
      expectedRevision: (yield* context.detail(plannable)).task.revision,
      modelSelection: selection("codex"),
    });
    const planner = context.caller(planned.planning?.threadId ?? "", {
      projectId: context.projectId,
      capabilities: ["houston-task-submit"],
    });

    // A handed-back implementation run under review.
    const reviewable = yield* context.readyTask(`Review me ${name}`);
    const started = yield* context.runs.start({ id: reviewable.key });
    yield* context.until(
      "the implementation waits for input",
      context
        .detail(reviewable)
        .pipe(
          Effect.map(
            (detail) =>
              detail.runs.find((run) => run.id === started.run.id)?.state === "waiting_for_input",
          ),
        ),
    );
    const implementation = (yield* context.detail(reviewable)).runs.find(
      (run) => run.id === started.run.id,
    )!;
    commitLines(implementation.worktreePath ?? "", "review.ts", 40);
    yield* context.runs.handback({ id: reviewable.key, summary: "ready for review" });
    const reviewing = yield* context.runs.reviewStart({ runId: implementation.id });
    const review = reviewing.runs.find((run) => run.kind === "review")!;
    const reviewer = context.caller(review.threadId ?? "", {
      projectId: context.projectId,
      capabilities: ["houston-task-submit"],
    });
    return { plannable, planner, implementation, review, reviewer };
  });

const planSubmitArgs = (task: Pick<HoustonTask, "key">) => ({
  id: task.key,
  proposal: {
    description: "the plan",
    acceptance: ["planned item"],
    pointers: [],
    outOfScope: [],
    questions: [],
  },
});

describe("project access gates every tool", () => {
  it.effect(
    "off refuses the 11 gated tools, read refuses their 8 writes, write lets all 11 succeed",
    () =>
      withToolkit("access", (context) =>
        Effect.gen(function* () {
          yield* context.setAccess("write");
          const agent = context.caller("agent-a", { projectId: context.projectId });

          const readable = yield* context.readyTask("Readable", {
            acceptance: ["first item", "second item"],
          });
          const item = (yield* context.detail(readable)).acceptance[0]!.id;
          const claimable = yield* context.readyTask("Claim me");
          const executable = yield* context.readyTask("Execute me");
          const { implementation } = yield* recordedSubmitters(context, "gated");

          const calls: ReadonlyArray<
            readonly [
              (typeof ALL_TOOLS)[number],
              McpInvocationContext.McpInvocationScope,
              Record<string, unknown>,
            ]
          > = [
            ["houston_task_list", agent, {}],
            ["houston_task_get", agent, { id: readable.key }],
            ["houston_task_next", agent, {}],
            ["houston_task_create", agent, { title: "Created by an agent" }],
            [
              "houston_task_update",
              agent,
              { id: readable.key, expectedRevision: readable.revision, title: "Readable, renamed" },
            ],
            ["houston_task_comment", agent, { id: readable.key, body: "an agent comment" }],
            ["houston_task_check", agent, { id: readable.key, item }],
            ["houston_task_claim", agent, { id: claimable.key }],
            ["houston_task_handback", agent, { id: claimable.key, summary: "claimed and done" }],
            ["houston_task_execute", agent, { id: executable.key }],
            ["houston_task_review", agent, { runId: implementation.id }],
          ];
          assert.deepEqual(
            calls.map(([name]) => name),
            ALL_TOOLS.filter((name) => !SUBMIT_TOOLS.includes(name)),
          );

          for (const access of ["off", "read", "write"] as const) {
            yield* context.setAccess(access);
            for (const [name, scope, args] of calls) {
              const result = yield* context.call(scope, name, args);
              const label = `${name} with access ${access}`;
              const writes = (WRITE_TOOLS as ReadonlyArray<string>).includes(name);
              if (access === "off") refused(result, label, "access_off", ACCESS_SETTING);
              else if (access === "read" && writes)
                refused(result, label, "read_only", ACCESS_SETTING, "read");
              else succeeded(result, label);
            }
          }
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "a planner and a reviewer the user started submit under access read and off",
    () =>
      withToolkit("access-submits", (context) =>
        Effect.gen(function* () {
          for (const access of ["read", "off"] as const) {
            yield* context.setAccess("write");
            const { plannable, planner, review, reviewer } = yield* recordedSubmitters(
              context,
              access,
            );
            yield* context.setAccess(access);
            succeeded(
              yield* context.call(planner, "houston_task_plan_submit", planSubmitArgs(plannable)),
              `plan submit with access ${access}`,
            );
            succeeded(
              yield* context.call(reviewer, "houston_task_review_submit", {
                runId: review.id,
                verdict: "pass",
                findings: [],
              }),
              `review submit with access ${access}`,
            );
            const planned = yield* context.detail(plannable);
            assert.strictEqual(
              planned.domain.plan?.proposal.description,
              "the plan",
              `the plan is stored under ${access}`,
            );
            const reviewed = yield* context.detail(yield* context.runs.taskOfRun(review.id));
            assert.strictEqual(
              reviewed.runs.find((run) => run.id === review.id)?.review?.verdict,
              "pass",
              `the review settles under ${access}`,
            );
          }
        }),
      ),
    TIMEOUT,
  );
});

describe("agents write only their own project or unassigned tasks", () => {
  it.effect(
    "a write to project B's task is read-only; project A's and unassigned tasks are writable",
    () =>
      withToolkit("write-scope", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const other = yield* context.tasks.save({
            patch: { title: "Other project task", projectId: context.otherProjectId },
          });
          const own = yield* context.tasks.save({
            patch: { title: "Own task", projectId: context.projectId },
          });
          const unassigned = yield* context.tasks.save({
            patch: { title: "Unassigned task", projectId: null },
          });

          for (const [name, args] of [
            ["houston_task_update", { id: other.key, expectedRevision: 1, title: "Taken" }],
            ["houston_task_comment", { id: other.key, body: "not mine" }],
          ] as const) {
            refused(
              yield* context.call(agent, name, args),
              name,
              "read_only",
              other.key,
              context.otherProjectId,
              OTHER_WORKSPACE,
            );
          }
          assert.strictEqual((yield* context.detail(other)).task.title, "Other project task");
          assert.lengthOf((yield* context.detail(other)).comments, 0);

          refused(
            yield* context.call(agent, "houston_task_create", {
              title: "Into project B",
              projectId: context.otherProjectId,
            }),
            "create in project B",
            "read_only",
            context.otherProjectId,
            OTHER_WORKSPACE,
          );

          for (const task of [own, unassigned]) {
            succeeded(
              yield* context.call(agent, "houston_task_update", {
                id: task.key,
                expectedRevision: task.revision,
                title: `${task.title}, edited`,
              }),
              `update ${task.key}`,
            );
            succeeded(
              yield* context.call(agent, "houston_task_comment", {
                id: task.key,
                body: "mine to comment",
              }),
              `comment ${task.key}`,
            );
          }
          assert.strictEqual((yield* context.detail(own)).task.title, "Own task, edited");
          assert.strictEqual(
            (yield* context.detail(unassigned)).task.title,
            "Unassigned task, edited",
          );
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "all 8 task-targeting writes to project B's tasks and runs are read-only and change nothing",
    () =>
      withToolkit("write-scope-all", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const owner = context.caller("agent-b", { projectId: context.otherProjectId });
          const otherTask = (title: string) =>
            context.tasks.save({
              patch: {
                title,
                status: "todo",
                acceptance: ["it works"],
                projectId: context.otherProjectId,
              },
            });
          const open = yield* otherTask("B open task");
          const item = (yield* context.detail(open)).acceptance[0]!.id;
          const claimed = yield* otherTask("B claimed task");
          succeeded(
            yield* context.call(owner, "houston_task_claim", { id: claimed.key }),
            "project B's own claim",
          );
          const runId = (yield* context.detail(claimed)).runs[0]!.id;
          const before = {
            open: yield* context.detail(open),
            claimed: yield* context.detail(claimed),
          };

          const writes: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
            ["houston_task_create", { title: "Into B", projectId: context.otherProjectId }, ""],
            [
              "houston_task_update",
              { id: open.key, expectedRevision: open.revision, title: "Taken" },
              open.key,
            ],
            ["houston_task_comment", { id: open.key, body: "not mine" }, open.key],
            ["houston_task_check", { id: open.key, item }, open.key],
            ["houston_task_claim", { id: open.key }, open.key],
            ["houston_task_handback", { id: claimed.key, summary: "not mine" }, claimed.key],
            ["houston_task_execute", { id: open.key }, open.key],
            ["houston_task_review", { runId }, claimed.key],
          ];
          assert.deepEqual(
            writes.map(([name]) => name),
            WRITE_TOOLS.filter((name) => !SUBMIT_TOOLS.includes(name)),
          );
          for (const [name, args, key] of writes) {
            refused(
              yield* context.call(agent, name, args),
              name,
              "read_only",
              context.otherProjectId,
              OTHER_WORKSPACE,
              key,
            );
          }
          const after = {
            open: yield* context.detail(open),
            claimed: yield* context.detail(claimed),
          };
          for (const which of ["open", "claimed"] as const) {
            assert.deepEqual(after[which].task, before[which].task, `${which} is unchanged`);
            assert.deepEqual(after[which].runs, before[which].runs, `${which}'s runs`);
            assert.deepEqual(after[which].comments, before[which].comments, `${which}'s comments`);
            assert.deepEqual(after[which].acceptance, before[which].acceptance);
          }
        }),
      ),
    TIMEOUT,
  );
});

describe("agents cannot mark a task done", () => {
  it.effect(
    "create and update with status done are invalid",
    () =>
      withToolkit("not-done", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          refused(
            yield* context.call(agent, "houston_task_create", {
              title: "Born done",
              status: "done",
            }),
            "create done",
            "invalid",
            "done",
          );
          const task = yield* context.readyTask("Finish me");
          refused(
            yield* context.call(agent, "houston_task_update", {
              id: task.key,
              expectedRevision: task.revision,
              status: "done",
            }),
            "update done",
            "invalid",
            "done",
          );
          assert.strictEqual((yield* context.detail(task)).task.status, "todo");
        }),
      ),
    TIMEOUT,
  );
});

describe("claim binds a run and refuses a second claimant", () => {
  it.effect(
    "a todo task moves to in progress under the caller; an unassigned one joins its project",
    () =>
      withToolkit("claim", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const task = yield* context.readyTask("Claim me");
          succeeded(yield* context.call(agent, "houston_task_claim", { id: task.key }), "claim");
          const claimed = yield* context.detail(task);
          assert.strictEqual(claimed.task.status, "in_progress");
          const run = claimed.runs[0];
          assert.strictEqual(run?.kind, "implementation");
          assert.strictEqual(run?.threadId, "agent-a");
          assert.strictEqual(run?.state, "running");

          const rival = context.caller("agent-b", { projectId: context.projectId });
          refused(
            yield* context.call(rival, "houston_task_claim", { id: task.key }),
            "second claim",
            "busy",
            "agent-a",
          );
          assert.lengthOf((yield* context.detail(task)).runs, 1);

          const unassigned = yield* context.tasks.save({
            patch: {
              title: "Unassigned claim",
              status: "todo",
              acceptance: ["it works"],
              projectId: null,
            },
          });
          succeeded(
            yield* context.call(agent, "houston_task_claim", { id: unassigned.key }),
            "claim unassigned",
          );
          const joined = yield* context.detail(unassigned);
          assert.strictEqual(joined.task.projectId, context.projectId);
          assert.strictEqual(joined.task.status, "in_progress");
          assert.strictEqual(joined.runs[0]?.threadId, "agent-a");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "an unready unassigned claim keeps the assignment without a run",
    () =>
      withToolkit("claim-unready", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const task = yield* context.tasks.save({
            patch: { title: "Unready unassigned", status: "todo", projectId: null },
          });
          refused(
            yield* context.call(agent, "houston_task_claim", { id: task.key }),
            "unready claim",
            "unready",
          );
          const after = yield* context.detail(task);
          assert.strictEqual(after.task.projectId, context.projectId, "the assignment stays");
          assert.lengthOf(after.runs, 0, "no run was created");
          assert.strictEqual(after.task.status, "todo");
        }),
      ),
    TIMEOUT,
  );
});

describe("a structured handback ticks acceptance and a malformed one needs review", () => {
  it.effect(
    "result.checked ticks the named items; a malformed result leaves the raw text",
    () =>
      withToolkit("handback", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const task = yield* context.readyTask("Fix login", {
            acceptance: ["Login no longer crashes", "A test covers it"],
          });
          succeeded(yield* context.call(agent, "houston_task_claim", { id: task.key }), "claim");
          succeeded(
            yield* context.call(agent, "houston_task_handback", {
              id: task.key,
              result: {
                checked: ["Login no longer crashes"],
                summary: "guarded the empty password",
              },
            }),
            "structured handback",
          );
          const handed = yield* context.detail(task);
          assert.strictEqual(handed.task.status, "in_review");
          assert.deepEqual(
            handed.acceptance.map((entry) => entry.checkedAt !== null),
            [true, false],
          );
          assert.strictEqual(handed.runs[0]?.state, "handed_back");
          assert.isTrue(
            handed.comments.some((comment) => comment.body.includes("guarded the empty password")),
          );

          const malformed = yield* context.readyTask("Fix logout");
          succeeded(
            yield* context.call(agent, "houston_task_claim", { id: malformed.key }),
            "claim",
          );
          yield* context.call(agent, "houston_task_handback", {
            id: malformed.key,
            result: { checked: "everything", note: "forgot the structured fields" },
          });
          const raw = yield* context.detail(malformed);
          assert.strictEqual(raw.runs[0]?.state, "needs_review");
          assert.strictEqual(raw.task.status, "in_progress", "a malformed result moves nothing");
          assert.isTrue(
            raw.comments.some((comment) => comment.body.includes("forgot the structured fields")),
            "the raw text is a comment",
          );
          assert.isTrue(raw.acceptance.every((entry) => entry.checkedAt === null));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "only the run's holder or its execute parent hands it back; anyone else is busy",
    () =>
      withToolkit("handback-holder", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ reviewer: null, reviewMode: "manual" });
          const holder = context.caller("agent-a", { projectId: context.projectId });
          const rival = context.caller("agent-b", { projectId: context.projectId });
          const unchanged = (task: Pick<HoustonTask, "key">, label: string) =>
            Effect.gen(function* () {
              const detail = yield* context.detail(task);
              assert.strictEqual(detail.task.status, "in_progress", label);
              assert.isTrue(
                detail.runs.every(
                  (run) => run.state !== "handed_back" && run.state !== "needs_review",
                ),
                label,
              );
              assert.lengthOf(detail.comments, 0, label);
            });

          // Agent B hands back agent A's claimed run, by summary and by a malformed result.
          const claimed = yield* context.readyTask("Claimed by A");
          succeeded(
            yield* context.call(holder, "houston_task_claim", { id: claimed.key }),
            "claim",
          );
          for (const args of [
            { id: claimed.key, summary: "B finished it" },
            { id: claimed.key, result: { checked: ["it works"], summary: "B finished it" } },
            { id: claimed.key, result: { note: "malformed, from B" } },
          ]) {
            refused(
              yield* context.call(rival, "houston_task_handback", args),
              `B's handback ${JSON.stringify(args)}`,
              "busy",
              "agent-a",
            );
          }
          yield* unchanged(claimed, "A's claim after B's handbacks");

          // An agent hands back a run the user started.
          const userTask = yield* context.readyTask("Started by the user");
          const started = yield* context.runs.start({ id: userTask.key });
          yield* context.until(
            "the user's run waits for input",
            context
              .detail(userTask)
              .pipe(Effect.map((detail) => detail.runs[0]?.state === "waiting_for_input")),
          );
          for (const args of [
            { id: userTask.key, summary: "an agent finished it" },
            { id: userTask.key, result: { note: "malformed" } },
          ]) {
            refused(
              yield* context.call(holder, "houston_task_handback", args),
              `an agent's handback of the user's run ${JSON.stringify(args)}`,
              "busy",
              started.run.threadId ?? "",
            );
          }
          yield* unchanged(userTask, "the user's run after an agent's handbacks");

          // The holder hands back its claim; an execute parent hands back its child's run.
          succeeded(
            yield* context.call(holder, "houston_task_handback", {
              id: claimed.key,
              summary: "A finished it",
            }),
            "the holder's handback",
          );
          assert.strictEqual((yield* context.detail(claimed)).task.status, "in_review");
          const executable = yield* context.readyTask("Executed by A");
          succeeded(
            yield* context.call(holder, "houston_task_execute", { id: executable.key }),
            "execute",
          );
          yield* context.until(
            "the child's run waits for input",
            context
              .detail(executable)
              .pipe(Effect.map((detail) => detail.runs[0]?.state === "waiting_for_input")),
          );
          refused(
            yield* context.call(rival, "houston_task_handback", {
              id: executable.key,
              summary: "B finished it",
            }),
            "B's handback of A's child",
            "busy",
          );
          succeeded(
            yield* context.call(holder, "houston_task_handback", {
              id: executable.key,
              summary: "my child finished it",
            }),
            "the execute parent's handback",
          );
          assert.strictEqual((yield* context.detail(executable)).task.status, "in_review");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "an over-long summary is refused with limit; a malformed result is stored cut, saying so",
    () =>
      withToolkit("handback-bounds", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ reviewer: null, reviewMode: "manual" });
          const agent = context.caller("agent-a", { projectId: context.projectId });
          const limit = 16_384;
          const long = "s".repeat(limit + 1);

          const task = yield* context.readyTask("Summarize me");
          succeeded(yield* context.call(agent, "houston_task_claim", { id: task.key }), "claim");
          for (const args of [
            { id: task.key, summary: long },
            { id: task.key, result: { checked: [], summary: long } },
          ]) {
            refused(
              yield* context.call(agent, "houston_task_handback", args),
              `an over-long summary${"result" in args ? " in a result" : ""}`,
              "limit",
              "houston_task_handback",
              String(limit),
              String(limit + 1),
              "summary",
            );
          }
          const kept = yield* context.detail(task);
          assert.strictEqual(kept.task.status, "in_progress", "a refused summary moves nothing");
          assert.strictEqual(kept.runs[0]?.state, "running");
          assert.lengthOf(kept.comments, 0);
          succeeded(
            yield* context.call(agent, "houston_task_handback", {
              id: task.key,
              summary: "s".repeat(limit),
            }),
            "a summary at the limit",
          );

          const malformed = yield* context.readyTask("Malformed and huge");
          succeeded(
            yield* context.call(agent, "houston_task_claim", { id: malformed.key }),
            "claim",
          );
          const note = "r".repeat(200 * 1024);
          yield* context.call(agent, "houston_task_handback", {
            id: malformed.key,
            result: { note },
          });
          const full = Buffer.byteLength(JSON.stringify({ note }), "utf8");
          const raw = yield* context.detail(malformed);
          const run = raw.runs[0]!;
          assert.strictEqual(run.state, "needs_review");
          const bytes = (text: string) => Buffer.byteLength(text, "utf8");
          assert.isAtMost(bytes(run.summary ?? ""), limit, "the stored raw result is bounded");
          assert.include(run.summary ?? "", `${full} bytes`, "the stored cut names the full size");
          const comment = raw.comments.at(-1)?.body ?? "";
          assert.isAtMost(bytes(comment), limit, "the comment is bounded");
          assert.include(comment, '{"note":"rrrr');
          assert.include(comment, `${full} bytes`, "the comment states its cut and the full size");
        }),
      ),
    TIMEOUT,
  );
});

describe("agent reads are capped and writes are attributed", () => {
  it.effect(
    "text fields stop at 8 KiB, comments at the newest 20, the label first; the title is kept",
    () =>
      withToolkit("caps", (context) =>
        Effect.gen(function* () {
          const agent = context.caller("agent-a", { projectId: context.projectId, title: "Fixer" });
          const task = yield* context.tasks.save({
            patch: {
              title: "Long task",
              description: "x".repeat(20_000),
              acceptance: ["y".repeat(150)],
              projectId: context.projectId,
            },
          });
          for (let index = 1; index <= 24; index += 1) {
            yield* context.tasks.comment({ id: task.key, body: `comment ${index}` });
          }
          yield* context.tasks.comment({ id: task.key, body: "z".repeat(9_000) });

          const read = yield* context.call(agent, "houston_task_get", { id: task.key });
          succeeded(read, "get");
          assert.isTrue(
            read.text.startsWith(`{"untrusted":${JSON.stringify(HOUSTON_TASK_UNTRUSTED_LABEL)}`),
            read.text.slice(0, 200),
          );
          const description: string = read.value.task.description;
          assert.isTrue(description.startsWith("x".repeat(8_192)));
          assert.isFalse(description.startsWith("x".repeat(8_193)), "cut at 8 KiB");
          assert.include(description, "20000 bytes", "the cut names the full size");
          const bodies = (read.value.comments as ReadonlyArray<{ body: string }>).map(
            (comment) => comment.body,
          );
          assert.lengthOf(bodies, 20);
          assert.strictEqual(bodies[0], "comment 6", "the newest 20, oldest first");
          assert.isTrue(bodies[19]!.startsWith("z".repeat(8_192)));
          assert.isFalse(bodies[19]!.startsWith("z".repeat(8_193)));

          const created = yield* context.call(agent, "houston_task_create", {
            title: "Agent's task",
          });
          succeeded(created, "create");
          const key: string = created.value.task.key;
          const actor = "agent:agent-a (Fixer)";
          context.rename("agent-a", "Renamed");
          succeeded(
            yield* context.call(agent, "houston_task_comment", { id: key, body: "later" }),
            "comment",
          );
          const detail = yield* context.detail({ key });
          assert.strictEqual(detail.task.createdBy, actor);
          assert.isTrue(
            detail.history.some((entry) => entry.action === "created" && entry.actor === actor),
            "the creation keeps the title at write time",
          );
          assert.strictEqual(detail.comments[0]?.author, "agent:agent-a (Renamed)");
        }),
      ),
    TIMEOUT,
  );
});

describe("execute starts a child for a delegating caller only", () => {
  it.effect(
    "a delegating thread starts the task in its worktree with its brief; others are denied",
    () =>
      withToolkit("execute", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ reviewer: null, reviewMode: "manual" });
          const orchestrator = context.caller("agent-a", { projectId: context.projectId });
          const task = yield* context.readyTask("Execute me");

          const denied: ReadonlyArray<readonly [string, McpInvocationContext.McpInvocationScope]> =
            [
              [
                "a thread without orchestration",
                context.caller("leaf", { projectId: context.projectId, capabilities: [] }),
              ],
              [
                "a delegated subagent",
                context.caller("subagent", { projectId: context.projectId, subagent: true }),
              ],
              [
                "a side thread",
                context.caller("aside", { projectId: context.projectId, side: true }),
              ],
              ["a read-only MCP client", readOnlyClient],
            ];
          for (const [label, scope] of denied) {
            refused(
              yield* context.call(scope, "houston_task_execute", { id: task.key }),
              `execute from ${label}`,
              "capability_denied",
            );
          }
          for (const [label, scope] of denied.slice(2)) {
            refused(
              yield* context.call(scope, "houston_task_create", { title: "Not from here" }),
              `create from ${label}`,
              "capability_denied",
            );
          }
          assert.lengthOf((yield* context.detail(task)).runs, 0, "no denied call started a run");

          const executed = yield* context.call(orchestrator, "houston_task_execute", {
            id: task.key,
            reviewer: selection("codex"),
          });
          succeeded(executed, "execute");
          const threadId = ThreadId.make(executed.value.threadId);
          yield* context.until(
            "the executed run's worktree",
            context
              .detail(task)
              .pipe(Effect.map((detail) => (detail.runs[0]?.worktreePath ?? null) !== null)),
          );
          const run = (yield* context.detail(task)).runs[0]!;
          assert.strictEqual(run.threadId, threadId);
          assert.isTrue(run.branch?.startsWith(`houston/task/hou-${task.number}-execute-me`));
          const projection = yield* context.orchestrator.getThreadProjection(threadId);
          const brief = projection.messages.find((message) => message.role === "user");
          assert.include(brief?.text ?? "", "<<<HOUSTON-TASK-DATA");
          assert.strictEqual(brief?.senderThreadId, "agent-a", "the brief comes from its parent");
          assert.strictEqual((yield* context.detail(task)).task.status, "in_progress");

          // The reviewer named at execute starts the handback review, though Settings names none.
          yield* context.until(
            "the executed run waits for input",
            context
              .detail(task)
              .pipe(Effect.map((detail) => detail.runs[0]?.state === "waiting_for_input")),
          );
          commitLines(run.worktreePath ?? "", "executed.ts", 40);
          yield* context.runs.handback({ id: task.key, summary: "executed" });
          const reviewed = yield* context.detail(task);
          const review = reviewed.runs.find((candidate) => candidate.kind === "review");
          assert.isDefined(review, "the handback review started");
          assert.strictEqual(review?.provider, "codex");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "the child runs within its caller's modes, created by an agent; a broader mode is refused",
    () =>
      withToolkit("execute-modes", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ reviewer: null, reviewMode: "manual" });
          const callers = [
            {
              label: "an approval-required caller",
              scope: context.caller("approver", {
                projectId: context.projectId,
                runtimeMode: "approval-required",
              }),
              child: { runtimeMode: "approval-required", interactionMode: "default" },
              broader: { runtimeMode: "full-access" },
              code: "runtime_mode_escalation_denied",
            },
            {
              label: "a plan-mode caller",
              scope: context.caller("planner-mode", {
                projectId: context.projectId,
                interactionMode: "plan",
              }),
              child: { runtimeMode: "full-access", interactionMode: "plan" },
              broader: { interactionMode: "default" },
              code: "interaction_mode_escalation_denied",
            },
            {
              label: "a full-access caller",
              scope: context.caller("full", { projectId: context.projectId }),
              child: { runtimeMode: "full-access", interactionMode: "default" },
              broader: undefined,
              code: undefined,
            },
          ] as const;
          for (const caller of callers) {
            if (caller.broader !== undefined) {
              const refusedTask = yield* context.readyTask(`Broader from ${caller.label}`);
              refused(
                yield* context.call(caller.scope, "houston_task_execute", {
                  id: refusedTask.key,
                  ...caller.broader,
                }),
                `a broader child from ${caller.label}`,
                caller.code,
              );
              const after = yield* context.detail(refusedTask);
              assert.lengthOf(after.runs, 0, `no run from ${caller.label}'s refused execute`);
              assert.strictEqual(after.task.status, "todo");
            }
            const task = yield* context.readyTask(`Executed by ${caller.label}`);
            const executed = yield* context.call(caller.scope, "houston_task_execute", {
              id: task.key,
            });
            succeeded(executed, `execute from ${caller.label}`);
            const projection = yield* context.orchestrator.getThreadProjection(
              ThreadId.make(executed.value.threadId),
            );
            assert.strictEqual(
              projection.thread.runtimeMode,
              caller.child.runtimeMode,
              `the child of ${caller.label}`,
            );
            assert.strictEqual(
              projection.thread.interactionMode,
              caller.child.interactionMode,
              `the child of ${caller.label}`,
            );
            assert.strictEqual(
              projection.thread.createdBy,
              "agent",
              `the child of ${caller.label}`,
            );
          }
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "an automatic rework of an executed child keeps the child's modes",
    () =>
      withToolkit("execute-rework", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({
            reviewer: selection("codex"),
            reviewMode: "handback",
            reworkRounds: 1,
          });
          const approver = context.caller("approver", {
            projectId: context.projectId,
            runtimeMode: "approval-required",
          });
          const task = yield* context.readyTask("Rework my child");
          succeeded(
            yield* context.call(approver, "houston_task_execute", { id: task.key }),
            "execute",
          );
          yield* context.until(
            "the child waits for input",
            context
              .detail(task)
              .pipe(Effect.map((detail) => detail.runs[0]?.state === "waiting_for_input")),
          );
          const first = (yield* context.detail(task)).runs[0]!;
          commitLines(first.worktreePath ?? "", "child.ts", 40);
          yield* context.runs.handback({ id: task.key, summary: "the child's work" });
          yield* context.until(
            "an open review",
            context
              .detail(task)
              .pipe(
                Effect.map((detail) =>
                  detail.runs.some((run) => run.kind === "review" && run.threadId !== null),
                ),
              ),
          );
          const review = (yield* context.detail(task)).runs.find((run) => run.kind === "review")!;
          yield* context.runs.reviewSubmit(ThreadId.make(review.threadId ?? ""), {
            runId: review.id,
            verdict: "fail",
            findings: [{ path: "a.ts", line: 1, severity: "high", category: "bug", message: "no" }],
          });
          yield* context.until(
            "attempt 2",
            context
              .detail(task)
              .pipe(
                Effect.map((detail) =>
                  detail.runs.some((run) => run.kind === "implementation" && run.attempt === 2),
                ),
              ),
          );
          const second = (yield* context.detail(task)).runs.find(
            (run) => run.kind === "implementation" && run.attempt === 2,
          )!;
          const projection = yield* context.orchestrator.getThreadProjection(
            ThreadId.make(second.threadId ?? ""),
          );
          assert.strictEqual(projection.thread.runtimeMode, "approval-required");
          assert.strictEqual(projection.thread.interactionMode, "default");
          assert.strictEqual(projection.thread.createdBy, "agent");
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    "review starts a reviewer for a delegating caller only",
    () =>
      withToolkit("review-delegation", (context) =>
        Effect.gen(function* () {
          yield* context.setSettings({ reviewer: null, reviewMode: "manual" });
          const holder = context.caller("agent-a", { projectId: context.projectId });
          const task = yield* context.readyTask("Review my claim");
          succeeded(yield* context.call(holder, "houston_task_claim", { id: task.key }), "claim");
          const runId = (yield* context.detail(task)).runs[0]!.id;

          for (const [label, scope] of [
            [
              "a thread without orchestration",
              context.caller("leaf", { projectId: context.projectId, capabilities: [] }),
            ],
            [
              "a delegated subagent",
              context.caller("subagent", { projectId: context.projectId, subagent: true }),
            ],
            [
              "a side thread",
              context.caller("aside", { projectId: context.projectId, side: true }),
            ],
            ["a read-only MCP client", readOnlyClient],
          ] as const) {
            refused(
              yield* context.call(scope, "houston_task_review", { runId }),
              `review from ${label}`,
              "capability_denied",
            );
          }
          assert.deepEqual(
            (yield* context.detail(task)).runs.map((run) => run.kind),
            ["implementation"],
            "no denied call started a review",
          );
        }),
      ),
    TIMEOUT,
  );
});

describe("no tool parameter unions a string with a scalar", () => {
  it.effect(
    "every houston_task_* input schema keeps one type per value",
    () =>
      withToolkit("schemas", () =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const scalar = new Set(["number", "integer", "boolean"]);
          const typesOf = (node: any): ReadonlyArray<string> =>
            typeof node?.type === "string"
              ? [node.type]
              : Array.isArray(node?.type)
                ? node.type
                : [];
          const offenders: Array<string> = [];
          const walk = (node: unknown, path: string) => {
            if (Array.isArray(node)) {
              node.forEach((item, index) => walk(item, `${path}[${index}]`));
              return;
            }
            if (node === null || typeof node !== "object") return;
            const record = node as Record<string, any>;
            const types = [
              ...typesOf(record),
              ...[...(record.anyOf ?? []), ...(record.oneOf ?? [])].flatMap(typesOf),
            ];
            if (types.includes("string") && types.some((type) => scalar.has(type)))
              offenders.push(path);
            for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
          };
          const tools = server.tools.filter(({ tool }) => tool.name.startsWith("houston_task_"));
          assert.lengthOf(tools, 13);
          for (const { tool } of tools) walk(tool.inputSchema, tool.name);
          assert.deepEqual(offenders, []);
          // Task ids are strings in every form an agent writes them.
          const get = tools.find(({ tool }) => tool.name === "houston_task_get")!;
          assert.strictEqual(
            (get.tool.inputSchema as any).properties.id.type,
            "string",
            "id is one string type",
          );
        }),
      ),
    TIMEOUT,
  );
});
