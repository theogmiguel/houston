// A task's planner or reviewer keeps a T3 MCP credential only to submit: the credential reaches
// the two submit tools and nothing else, and its read-only run loads no user MCP server.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { openCodePermissionRules } from "@t3tools/provider-opencode/server";
import { sessionRules } from "@t3tools/provider-opencode/server/v2/adapter";
import {
  claudeMcpQueryOverrides,
  makeClaudeQueryOptions,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ClaudeSettings } from "@t3tools/contracts";

const environmentId = EnvironmentId.make("environment-task-threads");
const planner = ThreadId.make("task-plan-1");

const scopeOf = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-task-threads",
  thread: {
    threadId: planner,
    providerSessionId: "provider-session-task-threads",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities,
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "task-threads", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "task-threads", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

// Upstream's write, delegate and read tools beside a stand-in for Houston's plan submit.
const PlanSubmit = Tool.make("houston_task_plan_submit", {
  description: "Stands in for the planner's submit.",
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});
const MixedToolkit = Toolkit.make(
  OrchestratorToolkit.tools.delegate_task,
  OrchestratorToolkit.tools.t3_thread_send,
  OrchestratorToolkit.tools.t3_thread_read,
  ProjectToolkit.tools.t3_project_update,
  PlanSubmit,
);

const layerMixedTools = (calls: Array<string>) => {
  const record = (name: string) =>
    McpToolAccess.reads(() =>
      Effect.sync(() => calls.push(name)).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." }),
          ),
        ),
      ),
    );
  return McpHttpServer.toolkitRegistration(
    MixedToolkit,
    McpToolAccess.toLayer(MixedToolkit, {
      delegate_task: record("delegate_task"),
      t3_thread_send: record("t3_thread_send"),
      t3_thread_read: record("t3_thread_read"),
      t3_project_update: record("t3_project_update"),
      houston_task_plan_submit: McpToolAccess.reads(() =>
        Effect.sync(() => calls.push("houston_task_plan_submit")).pipe(Effect.as({ ok: true })),
      ),
    }),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        NodeServices.layer,
      ),
    ),
  );
};

const callAs =
  (scope: McpInvocationContext.McpInvocationScope) =>
  (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });

const textOf = (result: unknown) =>
  ((result as McpSchema.CallToolResult).content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

const OTHER_TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["delegate_task", { task: "Write the code", target: {} }],
  ["t3_thread_send", { threadId: "thread-other", message: "go" }],
  ["t3_thread_read", { threadId: "thread-other" }],
  ["t3_project_update", { projectId: "project-1", title: "Renamed" }],
];

describe("a planner's credential reaches only the submit tools", () => {
  it.effect("every other T3 tool is refused before it runs; the submit runs", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const call = callAs(scopeOf(new Set(["houston-task-submit"])));
      for (const [name, args] of OTHER_TOOLS) {
        const result = yield* call(name, args);
        assert.isTrue((result as McpSchema.CallToolResult).isError, `${name} is refused`);
        assert.include(textOf(result), "capability_denied", name);
      }
      assert.deepEqual(calls, [], "no refused tool reached its handler");
      const submitted = yield* call("houston_task_plan_submit", {});
      assert.isFalse((submitted as McpSchema.CallToolResult).isError ?? false);
      assert.deepEqual(calls, ["houston_task_plan_submit"]);
    }).pipe(Effect.provide(layerMixedTools(calls)));
  });

  it.effect("a thread credential without the scope still reaches every tool", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const call = callAs(scopeOf(new Set(["orchestration", "worktree", "pull-requests"])));
      for (const [name, args] of OTHER_TOOLS) yield* call(name, args);
      assert.deepEqual(
        calls,
        OTHER_TOOLS.map(([name]) => name),
      );
    }).pipe(Effect.provide(layerMixedTools(calls)));
  });
});

describe("the submit-only guard is on the MCP call path", () => {
  it.effect(
    "tools registered outside the helpers, image tools included, refuse the credential",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const addDirect = (name: string, image: boolean) =>
            Effect.gen(function* () {
              const server = yield* McpServer.McpServer;
              yield* server.addTool({
                tool: new McpSchema.Tool({ name, inputSchema: { type: "object" } }),
                annotations: Context.empty(),
                handle: () =>
                  Effect.sync(() => {
                    calls.push(name);
                    return new McpSchema.CallToolResult({
                      isError: false,
                      content: image
                        ? [{ type: "image", data: new Uint8Array([1]), mimeType: "image/png" }]
                        : [{ type: "text", text: "ran" }],
                    });
                  }),
              });
            });
          const serverLayer = Layer.effectDiscard(
            Effect.all([
              addDirect("t3_thread_send", false),
              addDirect("html_preview", true),
              addDirect("houston_task_plan_submit", false),
            ]),
          ).pipe(
            Layer.provideMerge(
              McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
            ),
            Layer.provide(
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) =>
                  Effect.succeed(
                    token === "submit-only"
                      ? (scopeOf(
                          new Set(["houston-task-submit"]),
                        ) as McpInvocationContext.McpThreadInvocationScope)
                      : undefined,
                  ),
              }),
            ),
          );
          yield* HttpRouter.serve(serverLayer, {
            disableListenLog: true,
            disableLogger: true,
          }).pipe(Layer.build);
          const httpClient = yield* HttpClient.HttpClient;
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: "Bearer submit-only",
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"planner","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          assert.strictEqual(initialize.status, 200);
          const call = (id: number, name: string) =>
            httpClient
              .post("/mcp", {
                headers: {
                  ...headers,
                  "mcp-session-id": initialize.headers["mcp-session-id"]!,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.text(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    method: "tools/call",
                    params: { name, arguments: {} },
                  }),
                  "application/json",
                ),
              })
              .pipe(Effect.flatMap((response) => response.text));

          for (const [id, name] of [
            [2, "t3_thread_send"],
            [3, "html_preview"],
          ] as const) {
            const text = yield* call(id, name);
            assert.include(text, "capability_denied", name);
            assert.include(text, `"id":${id}`, name);
          }
          assert.deepEqual(calls, [], "no refused tool reached its handler");
          const submitted = yield* call(4, "houston_task_plan_submit");
          assert.notInclude(submitted, "capability_denied");
          assert.deepEqual(calls, ["houston_task_plan_submit"]);
        }),
      ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

describe("a planner is issued a submit-only credential", () => {
  it.effect(
    "the credential holds the submit scope and no orchestration, worktree or PR scope",
    () =>
      Effect.gen(function* () {
        const registry = yield* McpSessionRegistry.__testing.make();
        const issued = yield* registry.issue({
          threadId: planner,
          providerInstanceId: ProviderInstanceId.make("codex"),
          houstonTaskSubmitOnly: true,
        });
        const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
        const resolved = yield* registry.resolve(token);
        assert.deepEqual([...(resolved?.capabilities ?? [])], ["houston-task-submit"]);
        assert.deepEqual([...(issued.config.capabilities ?? [])], ["houston-task-submit"]);
      }).pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(NodeServices.layer),
      ),
  );
});

const READ_ONLY_POLICY = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/work",
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
} as const;

const SESSION = {
  environmentId,
  threadId: planner,
  providerSessionId: "provider-session-task-threads",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:43124/mcp",
  authorizationHeader: "Bearer planner-token",
  browserToolsAvailable: false,
};

describe("a planner's run loads no user MCP server", () => {
  it("Codex: the configured servers are replaced by Houston's server alone", () => {
    const params = codexThreadRuntimeParams({
      mcpSession: SESSION,
      runtimePolicy: READ_ONLY_POLICY,
    });
    assert.deepEqual(Object.keys(params.config.mcp_servers as object), ["t3-code"]);
    const houston = (params.config.mcp_servers as Record<string, Record<string, unknown>>)[
      "t3-code"
    ];
    assert.strictEqual(houston?.url, SESSION.endpoint);
    assert.deepEqual(houston?.http_headers, { Authorization: SESSION.authorizationHeader });
    assert.isFalse(Object.keys(params.config).some((key) => key.startsWith("mcp_servers.")));
  });

  it("Claude: strict MCP config with Houston's server only, and launch arguments add none", () => {
    const options = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native:task-plan",
      resume: false,
      cwd: "/work",
      settings: Schema.decodeSync(ClaudeSettings)({
        launchArgs: "--mcp-config /home/user/mcp.json",
      }),
      permissionMode: "dontAsk",
      mcpServers: {
        "t3-code": {
          type: "http",
          url: SESSION.endpoint,
          headers: { Authorization: SESSION.authorizationHeader },
        },
      },
      strictMcpConfig: true,
    });
    assert.isTrue(options.strictMcpConfig);
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["t3-code"]);
    assert.isUndefined(options.extraArgs?.["mcp-config"]);
  });
});

const SUBMIT_TOOLS = ["houston_task_plan_submit", "houston_task_review_submit"] as const;

/** The action of OpenCode's last rule that matches `permission`, as OpenCode evaluates them. */
const openCodeAction = (
  rules: ReadonlyArray<{ readonly permission: string; readonly action: string }>,
  permission: string,
) =>
  rules.findLast((rule) =>
    new RegExp(`^${rule.permission.replaceAll("*", ".*")}$`).test(permission),
  )?.action;

const openCodeV2Effect = (
  rules: ReadonlyArray<{ readonly action: string; readonly effect: string }>,
  action: string,
) =>
  rules.findLast((rule) => new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(action))
    ?.effect;

describe("a planner's and a reviewer's run may call its own submit tool", () => {
  it("Claude: a read-only run pre-approves exactly the role's submit tool", () => {
    for (const tool of SUBMIT_TOOLS) {
      const other = SUBMIT_TOOLS.find((candidate) => candidate !== tool);
      const allowedTools = [
        ...(claudeMcpQueryOverrides({
          mcpSession: SESSION,
          readOnlySandbox: true,
          houstonTaskSubmitTool: tool,
        }).allowedTools ?? []),
      ];
      assert.include(allowedTools, `mcp__t3-code__${tool}`, tool);
      assert.notInclude(allowedTools, `mcp__t3-code__${other}`, tool);
      assert.notInclude(allowedTools, "mcp__t3-code__*", tool);
    }
    const allowedTools = [
      ...(claudeMcpQueryOverrides({ mcpSession: SESSION, readOnlySandbox: true }).allowedTools ??
        []),
    ];
    for (const tool of SUBMIT_TOOLS) assert.notInclude(allowedTools, `mcp__t3-code__${tool}`);
  });

  it("OpenCode: a read-only run allows exactly the role's submit tool after the deny", () => {
    for (const tool of SUBMIT_TOOLS) {
      const other = SUBMIT_TOOLS.find((candidate) => candidate !== tool);
      const rules = openCodePermissionRules({ ...READ_ONLY_POLICY, houstonTaskSubmitTool: tool });
      assert.strictEqual(openCodeAction(rules, `t3-code_${tool}`), "allow", tool);
      assert.strictEqual(openCodeAction(rules, `t3-code_${other}`), "deny", tool);
      assert.strictEqual(openCodeAction(rules, "t3-code_delegate_task"), "deny", tool);
      assert.strictEqual(openCodeAction(rules, "edit"), "deny", tool);

      const v2 = sessionRules(
        { ...READ_ONLY_POLICY, houstonTaskSubmitTool: tool },
        [],
        [],
        "t3-code-task-plan-1",
      );
      assert.strictEqual(openCodeV2Effect(v2, `t3-code-task-plan-1_${tool}`), "allow", tool);
      assert.strictEqual(openCodeV2Effect(v2, `t3-code-task-plan-1_${other}`), "deny", tool);
      assert.strictEqual(openCodeV2Effect(v2, "t3-code-task-plan-1_delegate_task"), "deny", tool);
      assert.strictEqual(openCodeV2Effect(v2, "edit"), "deny", tool);
    }
    const plain = openCodePermissionRules(READ_ONLY_POLICY);
    for (const tool of SUBMIT_TOOLS) {
      assert.strictEqual(openCodeAction(plain, `t3-code_${tool}`), "deny");
    }
  });
});
