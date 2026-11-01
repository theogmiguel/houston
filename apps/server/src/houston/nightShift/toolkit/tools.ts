// The Night shift ledger for the threads of a live run: the orchestrator records plans, pull
// requests, lessons, decisions, studied versions and the report; another crew thread verdicts.
import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PositiveInt,
  ThreadId,
} from "@t3tools/contracts";
import { HoustonNightToolError } from "@t3tools/contracts/houston/nightShift";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { HoustonNightLanding } from "../landing/Landing.ts";
import { HoustonNightShiftRunner } from "../Runner.ts";
import { HoustonNightShiftStore } from "../Store.ts";

const shared = {
  failure: Schema.Union([
    HoustonNightToolError,
    OrchestratorMcpFailure,
    McpCapabilityUnavailableError,
  ]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HoustonNightShiftStore,
    HoustonNightShiftRunner,
    HoustonNightLanding,
    ServerConfig.ServerConfig,
    FileSystem.FileSystem,
    Path.Path,
  ],
};

const Text = Schema.String.check(Schema.isMaxLength(20_000));
const Short = Schema.String.check(Schema.isMaxLength(500));

/** A ledger entry as the tools answer it. */
export const HoustonNightEntry = Schema.Struct({
  id: PositiveInt,
  runId: PositiveInt,
  kind: Schema.String,
  title: Schema.String,
  status: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type HoustonNightEntry = typeof HoustonNightEntry.Type;

const EntryResult = Schema.Struct({ entry: HoustonNightEntry });

const PlanTool = Tool.make("houston_night_plan", {
  ...shared,
  description:
    "Orchestrator only. Record a plan: 1-20 claims, each with its proof. Deferred or rejected needs a reason.",
  parameters: Schema.Struct({
    title: Short,
    theme: Short,
    claims: Schema.Array(Schema.Struct({ claim: Text, proof: Text })),
    status: Schema.Literals(["planned", "deferred", "rejected"]),
    reason: Schema.optional(Text),
    /** Plan entries this one builds on; their pull requests merge first. */
    dependsOn: Schema.optional(Schema.Array(PositiveInt)),
  }),
  success: EntryResult,
}).annotate(Tool.Destructive, false);

const PrTool = Tool.make("houston_night_pr", {
  ...shared,
  description:
    "Orchestrator only. Record a pull request: Houston pushes the head of a run branch with a lease, opens or updates the draft, and runs the checks. Never push or open one yourself.",
  parameters: Schema.Struct({
    head: Schema.String,
    branch: Short,
    title: Short,
    body: Text,
    theme: Short,
    plans: Schema.Array(PositiveInt),
    builtBy: Schema.Array(ThreadId),
    visible: Schema.Boolean,
    task: Schema.optional(Short),
    // Named so a value is refused by name instead of dropped: Houston sets both gates.
    checks: Schema.optional(Schema.Unknown),
    ci: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Struct({
    entry: HoustonNightEntry,
    pullRequest: Schema.Struct({ number: PositiveInt, url: Schema.String }),
    push: Schema.Struct({
      branch: Schema.String,
      oldSha: Schema.NullOr(Schema.String),
      newSha: Schema.String,
    }),
  }),
}).annotate(Tool.Destructive, false);

const LessonTool = Tool.make("houston_night_lesson", {
  ...shared,
  description:
    "Orchestrator only. Record a lesson, or a flaky test with its check's name; the next run reads both.",
  parameters: Schema.Struct({
    kind: Schema.Literals(["lesson", "flaky"]),
    title: Short,
    body: Text,
    check: Schema.optional(Short),
  }),
  success: EntryResult,
}).annotate(Tool.Destructive, false);

const DecisionTool = Tool.make("houston_night_decision", {
  ...shared,
  description:
    "Orchestrator only. Park a question for the user with 2-5 options and your recommendation; do not wait for it.",
  parameters: Schema.Struct({
    title: Short,
    question: Text,
    options: Schema.Array(Short),
    recommendation: Short,
  }),
  success: EntryResult,
}).annotate(Tool.Destructive, false);

const StudiedTool = Tool.make("houston_night_studied", {
  ...shared,
  description: "Orchestrator only. Record the version of a configured competitor you studied.",
  parameters: Schema.Struct({ competitor: Short, version: Short }),
  success: EntryResult,
}).annotate(Tool.Destructive, false);

const VerdictTool = Tool.make("houston_night_verdict", {
  ...shared,
  description:
    "A crew thread that did not build the pull request verdicts one claim of one of its plans, with file:line evidence.",
  parameters: Schema.Struct({
    pullRequest: PositiveInt,
    plan: PositiveInt,
    claim: Schema.Int,
    passed: Schema.Boolean,
    evidence: Short,
    fault: Schema.optional(Text),
  }),
  success: EntryResult,
}).annotate(Tool.Destructive, false);

const ReportTool = Tool.make("houston_night_report", {
  ...shared,
  description:
    "Orchestrator only. Publish the morning report (markdown, at most 256 KiB) and a summary of 1-200 characters; the run ends once your turn ends.",
  parameters: Schema.Struct({ summary: Schema.String, report: Schema.String }),
  success: Schema.Struct({ reportPath: Schema.String }),
}).annotate(Tool.Destructive, false);

export const HoustonNightToolkit = Toolkit.make(
  PlanTool,
  PrTool,
  LessonTool,
  DecisionTool,
  StudiedTool,
  VerdictTool,
  ReportTool,
);

export const NIGHT_TOOLS = [
  "houston_night_plan",
  "houston_night_pr",
  "houston_night_lesson",
  "houston_night_decision",
  "houston_night_studied",
  "houston_night_verdict",
  "houston_night_report",
] as const;
