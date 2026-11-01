// @effect-diagnostics nodeBuiltinImport:off - checks the report file in the run folder.
// The houston_night_* tools over MCP with the real Night shift store; the caller's thread lookup
// and the runner's report hook are doubles.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS,
  type HoustonNightShiftSettings,
} from "@t3tools/contracts/houston/nightShift";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { defaultSettings } from "../rules.ts";
import { HoustonNightShiftRunner } from "../Runner.ts";
import * as Store from "../Store.ts";
import { LANDING_PENDING } from "./handlers.ts";
import { NIGHT_TOOLS } from "./tools.ts";

const NOW = "2026-10-30T22:00:00.000Z";
const projectId = ProjectId.make("project:night-tools");
const ORCHESTRATOR = ThreadId.make("night-tools-orchestrator");
const WORKER = ThreadId.make("night-tools-worker");
const REVIEWER = ThreadId.make("night-tools-reviewer");
const OUTSIDER = ThreadId.make("night-tools-outsider");

const settingsWith = (
  patch: Partial<HoustonNightShiftSettings> = {},
): HoustonNightShiftSettings => ({
  ...defaultSettings({
    orchestrator: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "m" },
    checks: [],
    startCommand: null,
  }),
  competitors: [{ repo: "acme/rival" }],
  ...patch,
});

const scopeOf = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:night-tools"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "night-tools", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "night-tools", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerStore = Store.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "houston-night-tools-" })),
  Layer.provideMerge(NodeServices.layer),
);

const published: Array<{ readonly runId: number; readonly summary: string }> = [];

const layerToolkit = McpHttpServer.layerHoustonNightToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed({
            ...liveThreadShell(threadId),
            projectId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          }),
      }),
      Layer.effect(
        HoustonNightShiftRunner,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          return HoustonNightShiftRunner.of({
            reportPublished: (
              runId: number,
              input: { readonly reportPath: string; readonly summary: string },
            ) =>
              Effect.sync(() => published.push({ runId, summary: input.summary })).pipe(
                Effect.andThen(store.setReport(runId, input)),
              ),
          } as never);
        }),
      ),
    ),
  ),
  Layer.provideMerge(layerStore),
);

interface Answer {
  readonly isError: boolean;
  readonly text: string;
  readonly value: any;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const call = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = (yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.orDie,
      )) as McpSchema.CallToolResult;
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const answer: Answer = { isError: result.isError === true, text, value: parse(text) };
    return answer;
  });

const accepted = (answer: Answer, label: string) =>
  assert.isFalse(answer.isError, `${label}: ${answer.text}`);

const refused = (answer: Answer, label: string, kind: string, ...parts: ReadonlyArray<string>) => {
  assert.isTrue(answer.isError, `${label} is refused: ${answer.text}`);
  assert.equal(answer.value?.kind, kind, `${label}: ${answer.text}`);
  for (const part of parts) assert.include(answer.text, part, label);
};

/** A live run with an orchestrator, a worker and a reviewer in its crew. */
const seedRun = (settings: HoustonNightShiftSettings = settingsWith()) =>
  Effect.gen(function* () {
    const store = yield* Store.HoustonNightShiftStore;
    const run = yield* store.openRun({
      projectId,
      trigger: "manual",
      scheduledTaskId: null,
      settings,
      startedAt: NOW,
      wrapUpAt: "2026-10-31T06:45:00.000Z",
      hardStopAt: "2026-10-31T07:30:00.000Z",
      operation: "test",
    });
    yield* store.markRunning(run.id, {
      threadId: ORCHESTRATOR,
      worktreePath: "/worktrees/night",
      branch: `houston/night/${run.id}`,
      remoteHeads: null,
    });
    for (const [threadId, role] of [
      [ORCHESTRATOR, "orchestrator"],
      [WORKER, "implementation"],
      [REVIEWER, "review"],
    ] as const) {
      yield* store.addCrew({
        runId: run.id,
        threadId,
        taskId: role === "orchestrator" ? null : `task:${threadId}`,
        parentThreadId: role === "orchestrator" ? null : ORCHESTRATOR,
        role,
        providerInstanceId: "claudeAgent",
        requestedInstanceId: null,
        worktreePath: null,
        branch: null,
        startedAt: NOW,
        endedAt: null,
      });
    }
    return run.id;
  });

const PLAN = {
  title: "Retry dropped uploads",
  theme: "reliability",
  claims: [
    { claim: "A dropped upload retries", proof: "upload.test.ts retries once" },
    { claim: "A retry keeps the order", proof: "upload.test.ts order" },
    { claim: "Three failures surface", proof: "upload.test.ts gives up" },
  ],
  status: "planned",
};

const VALID: Record<(typeof NIGHT_TOOLS)[number], Record<string, unknown>> = {
  houston_night_plan: PLAN,
  houston_night_pr: {
    head: "a".repeat(40),
    branch: "t3/fix-upload",
    title: "Retry dropped uploads",
    body: "Retries a dropped upload.",
    theme: "reliability",
    plans: [1],
    builtBy: [WORKER],
    visible: false,
  },
  houston_night_lesson: {
    kind: "lesson",
    title: "The sync tests need the fake clock",
    body: "Use TestClock.",
  },
  houston_night_decision: {
    title: "Drop the v1 importer?",
    question: "Keep the v1 importer?",
    options: ["keep", "drop"],
    recommendation: "keep",
  },
  houston_night_studied: { competitor: "acme/rival", version: "v2.3.0" },
  houston_night_verdict: {
    pullRequest: 41,
    plan: 1,
    claim: 0,
    passed: true,
    evidence: "src/upload.ts:42",
  },
  houston_night_report: { summary: "One fix landed.", report: "# Night\n\nOne fix." },
};

describe("night shift ledger tools", () => {
  it.effect("the toolkit offers the seven ledger tools", () =>
    Effect.gen(function* () {
      yield* seedRun();
      const server = yield* McpServer.McpServer;
      assert.deepEqual(
        server.tools.map(({ tool }) => tool.name).toSorted(),
        [...NIGHT_TOOLS].toSorted(),
      );
      // Each is reachable with the thread's credential: it answers, refusal or not, as itself.
      for (const name of NIGHT_TOOLS) {
        const answer = yield* call(OUTSIDER, name, VALID[name]);
        refused(answer, name, "not_in_run", name, OUTSIDER);
      }
    }).pipe(Effect.provide(layerToolkit)),
  );

  it.effect("ledger tools answer only their run's threads", () =>
    Effect.gen(function* () {
      yield* seedRun();
      // The orchestrator's ledger calls are accepted; its own verdict is refused.
      for (const name of [
        "houston_night_plan",
        "houston_night_lesson",
        "houston_night_decision",
        "houston_night_studied",
        "houston_night_report",
      ] as const) {
        accepted(yield* call(ORCHESTRATOR, name, VALID[name]), name);
      }
      // Recording a pull request is landing's (PR 3): refused by name until it ships.
      refused(
        yield* call(ORCHESTRATOR, "houston_night_pr", VALID.houston_night_pr),
        "pr",
        "unsupported",
        LANDING_PENDING,
      );
      refused(
        yield* call(ORCHESTRATOR, "houston_night_verdict", VALID.houston_night_verdict),
        "orchestrator verdict",
        "refused",
        ORCHESTRATOR,
      );
      for (const name of NIGHT_TOOLS.filter((tool) => tool !== "houston_night_verdict")) {
        refused(yield* call(WORKER, name, VALID[name]), `worker ${name}`, "refused", WORKER);
      }
      for (const name of NIGHT_TOOLS) {
        refused(
          yield* call(OUTSIDER, name, VALID[name]),
          `outsider ${name}`,
          "not_in_run",
          OUTSIDER,
        );
      }
    }).pipe(Effect.provide(layerToolkit)),
  );

  it.effect("ledger entries are validated and bounded", () =>
    Effect.gen(function* () {
      const store = yield* Store.HoustonNightShiftStore;
      const runId = yield* seedRun();
      const plan = (patch: Record<string, unknown>) =>
        call(ORCHESTRATOR, "houston_night_plan", { ...PLAN, ...patch });
      refused(yield* plan({ claims: [] }), "no claims", "invalid", "1-20", "0");
      const many = Array.from({ length: 21 }, (_, index) => ({
        claim: `c${index}`,
        proof: `p${index}`,
      }));
      refused(yield* plan({ claims: many }), "21 claims", "invalid", "1-20", "21");
      refused(
        yield* plan({ claims: [PLAN.claims[0], { claim: "unproven", proof: " " }] }),
        "a claim without a proof",
        "invalid",
        "claim 1",
      );
      for (const status of ["deferred", "rejected"] as const) {
        refused(
          yield* plan({ status, claims: [] }),
          `${status} without a reason`,
          "invalid",
          "reason",
        );
        const kept = yield* plan({ status, claims: [], reason: "Out of scope tonight" });
        accepted(kept, status);
        assert.equal(kept.value.entry.kind, "deferred");
        assert.equal(kept.value.entry.status, status);
      }
      refused(
        yield* call(ORCHESTRATOR, "houston_night_decision", {
          ...VALID.houston_night_decision,
          options: ["only"],
        }),
        "one option",
        "invalid",
        "2-5",
      );
      refused(
        yield* call(ORCHESTRATOR, "houston_night_decision", {
          ...VALID.houston_night_decision,
          options: ["a", "b", "c", "d", "e", "f"],
        }),
        "six options",
        "invalid",
        "2-5",
      );
      refused(
        yield* call(ORCHESTRATOR, "houston_night_studied", {
          competitor: "other/tool",
          version: "1",
        }),
        "an unconfigured competitor",
        "invalid",
        "other/tool",
      );
      refused(
        yield* call(ORCHESTRATOR, "houston_night_lesson", {
          kind: "flaky",
          title: "Flaky sync",
          body: "b",
        }),
        "flaky without a check",
        "invalid",
        "check",
      );

      // The 201st entry of a run is refused naming 200.
      const existing = (yield* store.runEntries(runId)).length;
      for (let index = existing; index < 200; index += 1) {
        yield* store.addEntry({
          runId,
          projectId,
          kind: "lesson",
          title: `l${index}`,
          createdAt: NOW,
        });
      }
      refused(yield* plan({}), "the 201st entry", "limit", "200");
      assert.lengthOf(yield* store.runEntries(runId), 200);
    }).pipe(Effect.provide(layerToolkit)),
  );

  it.effect("verdicts come from an independent crew thread", () =>
    Effect.gen(function* () {
      const store = yield* Store.HoustonNightShiftStore;
      const runId = yield* seedRun(settingsWith({ verification: "standard" }));
      const plan = yield* call(ORCHESTRATOR, "houston_night_plan", PLAN);
      accepted(plan, "plan");
      const planId = plan.value.entry.id as number;
      // Landing records pull requests in PR 3; the entry is seeded as it will record one.
      yield* store.addEntry({
        runId,
        projectId,
        kind: "pr",
        title: "Retry dropped uploads",
        prNumber: 41,
        detail: { plans: [planId], builtBy: [WORKER] },
        createdAt: NOW,
      });
      const verdict = (threadId: ThreadId, patch: Record<string, unknown>) =>
        call(threadId, "houston_night_verdict", {
          ...VALID.houston_night_verdict,
          plan: planId,
          ...patch,
        });
      refused(
        yield* verdict(ORCHESTRATOR, { fault: "f" }),
        "orchestrator",
        "refused",
        ORCHESTRATOR,
      );
      refused(yield* verdict(WORKER, { fault: "f" }), "builder", "refused", WORKER, "built #41");
      refused(
        yield* verdict(REVIEWER, { evidence: "src/upload.ts", fault: "f" }),
        "evidence without a line",
        "invalid",
        "<path>:<line>",
      );
      refused(
        yield* verdict(REVIEWER, { claim: 3, fault: "f" }),
        "no such claim",
        "invalid",
        "claim 3",
      );
      refused(
        yield* verdict(REVIEWER, {}),
        "passing without a fault at standard",
        "invalid",
        "fault",
      );
      accepted(
        yield* verdict(REVIEWER, { fault: "Dropped the retry; the test failed" }),
        "verdict",
      );
      accepted(
        yield* verdict(REVIEWER, { claim: 1, passed: false }),
        "a failing verdict needs no fault",
      );
      const verdicts = (yield* store.runEntries(runId)).filter((entry) => entry.kind === "verdict");
      assert.deepEqual(
        verdicts.map((entry) => entry.status),
        ["passed", "failed"],
      );
    }).pipe(Effect.provide(layerToolkit)),
  );

  it.effect("the report is bounded and replaceable", () =>
    Effect.gen(function* () {
      const store = yield* Store.HoustonNightShiftStore;
      const config = yield* ServerConfig.ServerConfig;
      const runId = yield* seedRun();
      const report = (summary: string, text: string) =>
        call(ORCHESTRATOR, "houston_night_report", { summary, report: text });
      const first = yield* report("One fix landed.", "# First\n");
      accepted(first, "report");
      const file = NodePath.join(Store.runFolder(config.baseDir, runId), "report.md");
      assert.equal(first.value.reportPath, file);
      assert.equal(NodeFS.readFileSync(file, "utf8"), "# First\n");
      assert.equal((yield* store.getRun(runId))?.summary, "One fix landed.");
      assert.deepEqual(published.at(-1), { runId, summary: "One fix landed." });

      refused(yield* report("", "# r"), "an empty summary", "invalid", "200");
      refused(yield* report("x".repeat(201), "# r"), "201 characters", "invalid", "201", "200");
      const bound = HOUSTON_NIGHT_SHIFT_LIMITS.reportBytes;
      refused(
        yield* report("Too long.", "x".repeat(bound + 1)),
        "256 KiB + 1",
        "limit",
        String(bound + 1),
        String(bound),
      );
      assert.equal(NodeFS.readFileSync(file, "utf8"), "# First\n", "a refusal writes nothing");

      accepted(yield* report("Two fixes landed.", "# Second\n"), "second report");
      assert.equal(NodeFS.readFileSync(file, "utf8"), "# Second\n");
      assert.equal((yield* store.getRun(runId))?.summary, "Two fixes landed.");
    }).pipe(Effect.provide(layerToolkit)),
  );
});
