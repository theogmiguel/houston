// houston_defect_report through upstream's MCP server: a project thread reports into its project;
// a review thread holds no T3 tool. Defects and projects are real (the harness kit); only the
// caller thread lookup is a double.
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { mayHoldT3Tools } from "../../sideThreads.ts";
import {
  HoustonDefects,
  HoustonHarnessService,
  createProject,
  makeKit,
  runKit,
} from "../harnessReview.testkit.ts";

const TIMEOUT = 180_000;
const environmentId = EnvironmentId.make("environment-defect-tools");

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "defect-tools", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "defect-tools", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const scopeOf = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const textOf = (result: McpSchema.CallToolResult) =>
  (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");

describe("the defect toolkit", () => {
  it.effect(
    "the toolkit offers one report tool to project threads only",
    () =>
      Effect.gen(function* () {
        const kit = yield* makeKit("defect-toolkit", { reactor: false });
        yield* runKit(
          kit,
          Effect.gen(function* () {
            const { projectId } = yield* createProject("defect-toolkit");
            const shells = new Map<string, OrchestrationV2ThreadShell>();
            const caller = (
              id: string,
              side?: OrchestrationV2ThreadShell["side"],
            ): McpInvocationContext.McpInvocationScope => {
              const threadId = ThreadId.make(id);
              shells.set(id, {
                ...liveThreadShell(threadId, { activeRunId: RunId.make(`run-${id}`) }),
                projectId: projectId as ProjectId,
                title: id,
                ...(side === undefined ? {} : { side }),
              });
              return scopeOf(threadId);
            };
            const services = yield* Effect.context<HoustonDefects.HoustonDefects>();
            const toolkit = McpHttpServer.layerHoustonDefectToolkit.pipe(
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
            yield* Effect.gen(function* () {
              const server = yield* McpServer.McpServer;
              const call = (scope: McpInvocationContext.McpInvocationScope, args: object) =>
                server.callTool({ name: "houston_defect_report", arguments: args }).pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                  Effect.provideService(McpSchema.McpServerClient, client),
                  Effect.orDie,
                  Effect.map((result) => {
                    const call = result as McpSchema.CallToolResult;
                    return { isError: call.isError === true, text: textOf(call) };
                  }),
                );

              const names = server.tools
                .map(({ tool }) => tool.name)
                .filter((name) => name.startsWith("houston_defect"));
              assert.deepEqual(names, ["houston_defect_report"]);

              const reported = yield* call(caller("thread-agent"), {
                title: "worker re-asked the same question",
                evidence: ["message 12"],
                destination: "houston",
              });
              assert.isFalse(reported.isError, reported.text);
              const value = JSON.parse(reported.text) as {
                recorded: boolean;
                key: string;
                count: number;
                note: string;
              };
              assert.isTrue(value.recorded);
              assert.strictEqual(value.count, 1);
              assert.strictEqual(value.note, "Stored as a suspected defect; nothing is sent anywhere.");
              const snapshot = yield* (yield* HoustonHarnessService.HoustonHarnessService).get({
                projectId,
              });
              assert.deepEqual(
                snapshot.defects.map((defect) => defect.key),
                [value.key],
                "stored in the caller's project",
              );

              const invalid = yield* call(caller("thread-agent"), {
                title: "x".repeat(121),
                destination: "houston",
              });
              assert.isTrue(invalid.isError);
              assert.include(invalid.text, "120");

              // A review thread: read-only and given no T3 MCP credential at all.
              const review = { kind: "harnessReview" as const, reviewId: 1 };
              assert.isFalse(yield* mayHoldT3Tools(Effect.succeed({ side: review })));
              const refused = yield* call(caller("harness-review:1", review), {
                title: "a review thread reports",
                destination: "houston",
              });
              assert.isTrue(refused.isError);
              assert.include(refused.text, "side thread");
              assert.lengthOf(
                (yield* (yield* HoustonDefects.HoustonDefects).list(projectId)),
                1,
                "the refusal stored nothing",
              );
              assert.lengthOf(kit.github.requests, 0);
            }).pipe(Effect.provide(toolkit));
          }),
        );
      }),
    TIMEOUT,
  );
});
