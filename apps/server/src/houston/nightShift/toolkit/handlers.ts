// Every call first finds the caller in a live run's crew: outside every live run it is
// `not_in_run`; the ledger tools are the orchestrator's and a verdict is another crew thread's.
import type { ThreadId } from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_LEDGER_LIMITS as LEDGER,
  HOUSTON_NIGHT_SHIFT_LIMITS,
  HoustonNightToolError,
  type HoustonNightToolErrorKind,
  type NightCrewMember,
  type NightEntryKind,
} from "@t3tools/contracts/houston/nightShift";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { HoustonNightLanding } from "../landing/Landing.ts";
import { HoustonNightShiftRunner } from "../Runner.ts";
import { HoustonNightShiftStore, type LedgerEntry, runFolder, type StoredRun } from "../Store.ts";
import { type HoustonNightEntry, HoustonNightToolkit } from "./tools.ts";

const fail = (
  kind: HoustonNightToolErrorKind,
  tool: string,
  message: string,
  numbers: { readonly limit?: number; readonly actual?: number } = {},
) =>
  Effect.fail(
    new HoustonNightToolError({ kind, tool, message: `${tool}: ${message}`, ...numbers }),
  );

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

interface Caller {
  readonly threadId: ThreadId;
  readonly run: StoredRun;
  readonly member: NightCrewMember;
}

/** The caller's live run and crew row; `not_in_run` outside every live run's crew. */
const callerOf = Effect.fn("HoustonNightToolkit.callerOf")(function* (tool: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, tool);
  const threadId = threadScope.thread.threadId;
  const membership = yield* (yield* HoustonNightShiftStore).liveCrewOf(threadId);
  if (membership === undefined) {
    return yield* fail(
      "not_in_run",
      tool,
      `thread ${threadId} is not in the crew of a live Night shift run`,
    );
  }
  return { threadId, run: membership.run, member: membership.member } satisfies Caller;
});

const orchestratorOf = Effect.fn("HoustonNightToolkit.orchestratorOf")(function* (tool: string) {
  const caller = yield* callerOf(tool);
  if (caller.member.role !== "orchestrator") {
    return yield* fail(
      "refused",
      tool,
      `thread ${caller.threadId} is a ${caller.member.role} thread of run ${caller.run.id}; only the run's orchestrator records this`,
    );
  }
  return caller;
});

const nonEmpty = (text: string | undefined) => text !== undefined && text.trim() !== "";

const toEntry = (row: LedgerEntry): HoustonNightEntry => ({
  id: row.id,
  runId: row.run_id,
  kind: row.kind,
  title: row.title,
  status: row.status,
  createdAt: row.created_at,
});

/** Adds an entry within the run's bounds. */
const record = Effect.fn("HoustonNightToolkit.record")(function* (
  tool: string,
  caller: Caller,
  entry: {
    readonly kind: NightEntryKind;
    readonly title: string;
    readonly theme?: string | null;
    readonly status?: string | null;
    readonly body?: string;
    readonly detail?: unknown;
  },
) {
  const store = yield* HoustonNightShiftStore;
  // The bounds are checked in the insert, so parallel calls cannot both take the last place.
  const added = yield* store.addEntryWithin(
    {
      runId: caller.run.id,
      projectId: caller.run.projectId,
      authorThreadId: caller.threadId,
      createdAt: iso(yield* Clock.currentTimeMillis),
      ...entry,
    },
    { entries: LEDGER.entriesPerRun, decisions: LEDGER.decisionsPerRun },
  );
  if ("entry" in added) return { entry: toEntry(added.entry) };
  if (added.entries >= LEDGER.entriesPerRun) {
    return yield* fail(
      "limit",
      tool,
      `run ${caller.run.id} holds ${added.entries} entries; the limit is ${LEDGER.entriesPerRun} per run`,
      { limit: LEDGER.entriesPerRun, actual: added.entries },
    );
  }
  return yield* fail(
    "limit",
    tool,
    `run ${caller.run.id} holds ${added.decisions} decisions; the limit is ${LEDGER.decisionsPerRun} per run`,
    { limit: LEDGER.decisionsPerRun, actual: added.decisions },
  );
});

const decodeDetail = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const detailOf = (row: LedgerEntry): Record<string, unknown> => {
  const value = decodeDetail(row.detail_json);
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

const EVIDENCE = /^\S(?:.*\S)?:\d+$/;
const HEAD = /^[0-9a-f]{40}$/;

export const layer = McpToolAccess.toLayer(HoustonNightToolkit, {
  houston_night_plan: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_plan";
      const caller = yield* orchestratorOf(tool);
      if (!nonEmpty(input.title)) return yield* fail("invalid", tool, "the title is empty");
      if (input.status === "planned") {
        if (input.claims.length < LEDGER.claimsMin || input.claims.length > LEDGER.claimsMax) {
          return yield* fail(
            "invalid",
            tool,
            `a planned entry needs ${LEDGER.claimsMin}-${LEDGER.claimsMax} claims; it has ${input.claims.length}`,
          );
        }
        const missing = input.claims.findIndex(
          (claim) => !nonEmpty(claim.claim) || !nonEmpty(claim.proof),
        );
        if (missing !== -1) {
          return yield* fail("invalid", tool, `claim ${missing} needs a non-empty claim and proof`);
        }
        return yield* record(tool, caller, {
          kind: "plan",
          title: input.title,
          theme: input.theme,
          status: "planned",
          detail: { claims: input.claims, dependsOn: input.dependsOn ?? [] },
        });
      }
      if (!nonEmpty(input.reason)) {
        return yield* fail("invalid", tool, `a ${input.status} entry needs a reason`);
      }
      return yield* record(tool, caller, {
        kind: "deferred",
        title: input.title,
        theme: input.theme,
        status: input.status,
        body: input.reason!,
        detail: { claims: input.claims },
      });
    }),
  ),
  houston_night_pr: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_pr";
      const caller = yield* orchestratorOf(tool);
      if (!HEAD.test(input.head)) {
        return yield* fail("invalid", tool, `head ${input.head} is not a 40-character hex SHA`);
      }
      if (!nonEmpty(input.title)) return yield* fail("invalid", tool, "the title is empty");
      const recorded = yield* (yield* HoustonNightLanding).record({
        runId: caller.run.id,
        callerThreadId: caller.threadId,
        head: input.head,
        branch: input.branch,
        title: input.title,
        body: input.body,
        theme: input.theme,
        plans: input.plans,
        builtBy: input.builtBy,
        visible: input.visible,
        task: input.task,
        checks: input.checks,
        ci: input.ci,
      });
      return {
        entry: toEntry(recorded.entry),
        pullRequest: recorded.pullRequest,
        push: recorded.push,
      };
    }),
  ),
  houston_night_lesson: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_lesson";
      const caller = yield* orchestratorOf(tool);
      if (!nonEmpty(input.title)) return yield* fail("invalid", tool, "the title is empty");
      if (input.kind === "flaky" && !nonEmpty(input.check)) {
        return yield* fail("invalid", tool, "a flaky test needs the name of its check");
      }
      return yield* record(tool, caller, {
        kind: input.kind,
        title: input.title,
        body: input.body,
        detail: input.check === undefined ? {} : { check: input.check },
      });
    }),
  ),
  houston_night_decision: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_decision";
      const caller = yield* orchestratorOf(tool);
      if (input.options.length < LEDGER.optionsMin || input.options.length > LEDGER.optionsMax) {
        return yield* fail(
          "invalid",
          tool,
          `a decision needs ${LEDGER.optionsMin}-${LEDGER.optionsMax} options; it has ${input.options.length}`,
        );
      }
      if (!nonEmpty(input.title) || !nonEmpty(input.question)) {
        return yield* fail("invalid", tool, "the title and the question must not be empty");
      }
      return yield* record(tool, caller, {
        kind: "decision",
        title: input.title,
        body: input.question,
        detail: { options: input.options, recommendation: input.recommendation },
      });
    }),
  ),
  houston_night_studied: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_studied";
      const caller = yield* orchestratorOf(tool);
      const configured = caller.run.settings.competitors.map((competitor) => competitor.repo);
      if (!configured.includes(input.competitor)) {
        return yield* fail(
          "invalid",
          tool,
          `${input.competitor} is not a configured competitor (${configured.length === 0 ? "none is configured" : configured.join(", ")})`,
        );
      }
      if (!nonEmpty(input.version)) return yield* fail("invalid", tool, "the version is empty");
      return yield* record(tool, caller, {
        kind: "studied",
        title: input.competitor,
        body: input.version,
        detail: { competitor: input.competitor, version: input.version },
      });
    }),
  ),
  houston_night_verdict: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_verdict";
      const caller = yield* callerOf(tool);
      if (caller.member.role === "orchestrator") {
        return yield* fail(
          "refused",
          tool,
          `thread ${caller.threadId} is run ${caller.run.id}'s orchestrator; a verdict comes from another crew thread`,
        );
      }
      const entries = yield* (yield* HoustonNightShiftStore).runEntries(caller.run.id);
      const pullRequest = entries.find(
        (entry) => entry.kind === "pr" && entry.pr_number === input.pullRequest,
      );
      if (pullRequest === undefined) {
        return yield* fail(
          "invalid",
          tool,
          `run ${caller.run.id} recorded no pull request #${input.pullRequest}`,
        );
      }
      const detail = detailOf(pullRequest);
      const builtBy = Array.isArray(detail.builtBy)
        ? (detail.builtBy as ReadonlyArray<string>)
        : [];
      if (builtBy.includes(caller.threadId)) {
        return yield* fail(
          "refused",
          tool,
          `thread ${caller.threadId} built #${input.pullRequest}; a verdict comes from a thread that did not`,
        );
      }
      const plans = Array.isArray(detail.plans) ? (detail.plans as ReadonlyArray<number>) : [];
      const plan = entries.find((entry) => entry.id === input.plan && entry.kind === "plan");
      const claims = plan === undefined ? [] : detailOf(plan).claims;
      if (
        !plans.includes(input.plan) ||
        plan === undefined ||
        !Array.isArray(claims) ||
        input.claim < 0 ||
        input.claim >= claims.length
      ) {
        return yield* fail(
          "invalid",
          tool,
          `#${input.pullRequest} has no claim ${input.claim} of plan ${input.plan}`,
        );
      }
      if (!EVIDENCE.test(input.evidence)) {
        return yield* fail("invalid", tool, `evidence ${input.evidence} is not <path>:<line>`);
      }
      if (
        input.passed &&
        caller.run.settings.verification === "standard" &&
        !nonEmpty(input.fault)
      ) {
        return yield* fail(
          "invalid",
          tool,
          "verification is standard: a passing verdict names the fault it injected and saw caught",
        );
      }
      const verdict = yield* record(tool, caller, {
        kind: "verdict",
        title: `#${input.pullRequest} plan ${input.plan} claim ${input.claim}`,
        status: input.passed ? "passed" : "failed",
        body: input.evidence,
        detail: {
          pullRequest: input.pullRequest,
          plan: input.plan,
          claim: input.claim,
          passed: input.passed,
          evidence: input.evidence,
          ...(input.fault === undefined ? {} : { fault: input.fault }),
        },
      });
      // A verdict moves the Verify and Review gates, so the merge queue output may enqueue now.
      yield* (yield* HoustonNightLanding).evaluateNumber(caller.run.id, input.pullRequest);
      return verdict;
    }),
  ),
  houston_night_report: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_night_report";
      const caller = yield* orchestratorOf(tool);
      const summary = input.summary.trim();
      if (summary.length === 0 || summary.length > LEDGER.summaryChars) {
        return yield* fail(
          "invalid",
          tool,
          `the summary has ${summary.length} characters; it needs 1-${LEDGER.summaryChars}`,
        );
      }
      const bytes = Buffer.byteLength(input.report, "utf8");
      if (bytes > HOUSTON_NIGHT_SHIFT_LIMITS.reportBytes) {
        return yield* fail(
          "limit",
          tool,
          `the report is ${bytes} bytes; the limit is ${HOUSTON_NIGHT_SHIFT_LIMITS.reportBytes} bytes`,
          { limit: HOUSTON_NIGHT_SHIFT_LIMITS.reportBytes, actual: bytes },
        );
      }
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = runFolder(config.baseDir, caller.run.id);
      const reportPath = path.join(folder, "report.md");
      yield* fs.makeDirectory(folder, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(reportPath, input.report)),
        Effect.catch((error) =>
          fail("invalid", tool, `writing ${reportPath} failed: ${error.message}`),
        ),
      );
      yield* (yield* HoustonNightShiftRunner).reportPublished(caller.run.id, {
        reportPath,
        summary,
      });
      return { reportPath };
    }),
  ),
});
