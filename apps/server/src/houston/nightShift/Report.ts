// The morning report of one run: what `houston.nightShift.report` gathers from the ledger, the
// run row and `report.md`. Reads only; nothing here is sent off the machine.
import {
  HOUSTON_NIGHT_REPORT_READ_BYTES,
  HoustonNightShiftError,
  NightCost,
  type HoustonNightReport,
  type NightRemoteChange,
  type NightReportClaim,
  type NightReportDecision,
  type NightReportPullRequest,
} from "@t3tools/contracts/houston/nightShift";
import { houstonTaskKey } from "@t3tools/contracts/houston/tasks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { NightShiftBacklog } from "./Host.ts";
import { mergeOrder } from "./landing/rules.ts";
import { planDependencies, prDetail } from "./landing/Landing.ts";
import { headline } from "./rules.ts";
import { HoustonNightShiftStore, type LedgerEntry } from "./Store.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isCost = Schema.is(NightCost);
const objectOf = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const detailOf = (row: LedgerEntry) => objectOf(decodeJson(row.detail_json));
const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const decisionOf = (row: LedgerEntry): NightReportDecision => {
  const detail = detailOf(row);
  return {
    entryId: row.id,
    title: row.title,
    question: row.body,
    options: strings(detail.options),
    recommendation: typeof detail.recommendation === "string" ? detail.recommendation : null,
    choice: row.choice,
    decidedAt: row.decided_at,
  };
};

export const buildReport = Effect.fn("HoustonNightReport.build")(function* (runId: number) {
  const store = yield* HoustonNightShiftStore;
  const fs = yield* FileSystem.FileSystem;
  const backlog = yield* NightShiftBacklog;
  const run = yield* store.getRun(runId);
  if (run === undefined) {
    return yield* new HoustonNightShiftError({
      kind: "not_found",
      operation: "houston.nightShift.report",
      message: `no Night shift run ${runId}`,
    });
  }
  const entries = yield* store.runEntries(runId);
  const crew = yield* store.crew(runId);
  const prs = entries.filter((row) => row.kind === "pr" && row.pr_number !== null);
  const decisions = entries.filter((row) => row.kind === "decision");
  const verdicts = entries
    .filter((row) => row.kind === "verdict")
    .map((row) => ({ row, detail: detailOf(row) }));

  const claimsOf = (number: number, plans: ReadonlyArray<number>): Array<NightReportClaim> =>
    plans.flatMap((plan) => {
      const planRow = entries.find((row) => row.id === plan && row.kind === "plan");
      const listed = planRow === undefined ? [] : detailOf(planRow).claims;
      return (Array.isArray(listed) ? listed : []).map((claim, index) => {
        const verdict = verdicts
          .filter(
            (item) =>
              item.detail.pullRequest === number &&
              item.detail.plan === plan &&
              item.detail.claim === index,
          )
          .at(-1);
        return {
          plan,
          index,
          claim: typeof claim?.claim === "string" ? claim.claim : "",
          verdict:
            verdict === undefined ? null : verdict.detail.passed === true ? "passed" : "failed",
          evidence: typeof verdict?.detail.evidence === "string" ? verdict.detail.evidence : null,
          fault: typeof verdict?.detail.fault === "string" ? verdict.detail.fault : null,
        } satisfies NightReportClaim;
      });
    });

  const groups = new Map<string, Array<NightReportPullRequest>>();
  for (const row of prs) {
    const detail = prDetail(row);
    const theme = row.theme ?? "unthemed";
    const failedChecks = [
      ...detail.checks.results
        .filter((result) => !result.passed)
        .map((result) => ({ name: result.command, url: null })),
      ...detail.ci.failing,
    ];
    const list = groups.get(theme) ?? [];
    list.push({
      entryId: row.id,
      number: row.pr_number!,
      url: detail.url,
      title: row.title,
      branch: row.branch,
      headSha: row.head_sha,
      fate: row.status,
      visible: detail.visible || row.visible === 1,
      held: detail.held,
      qaPassed: row.qa_passed === 1,
      gates: detail.gates,
      failedChecks,
      claims: claimsOf(row.pr_number!, detail.plans),
    });
    groups.set(theme, list);
  }

  const picks = yield* Effect.forEach(
    entries.filter((row) => row.kind === "pick" && row.task_number !== null),
    (row) =>
      Effect.map(backlog.status(houstonTaskKey(row.task_number!)), (status) => ({
        taskNumber: row.task_number!,
        title: row.title,
        status,
      })),
  );

  const audit = objectOf(run.remoteChanges);
  const remoteChanges: ReadonlyArray<NightRemoteChange> = Array.isArray(audit.changes)
    ? audit.changes
    : [];
  const events: Array<HoustonNightReport["events"][number]> = [
    ...remoteChanges.map((change) => ({
      kind: "remoteChange" as const,
      at: run.endedAt,
      text: `${change.ref} changed outside Houston, from ${change.oldSha ?? "nothing"} to ${change.newSha ?? "deleted"}; it is not attributable to a Houston push or a merge queue merge`,
    })),
    ...(typeof audit.error === "string"
      ? [
          {
            kind: "audit" as const,
            at: run.endedAt,
            text: `The remote audit could not run: ${audit.error}`,
          },
        ]
      : []),
    ...run.interruptions.map((item) => ({
      kind: "interruption" as const,
      at: item.at,
      text: item.detail,
    })),
    ...run.limited.map((limit) => ({
      kind: "limit" as const,
      at: limit.at,
      text: `${limit.instanceId} became ${limit.state}${limit.resetsAt === null ? "" : `, resetting at ${limit.resetsAt}`}${limit.clearedAt === null ? "" : `; usable again at ${limit.clearedAt}`}`,
    })),
    ...crew
      .filter(
        (member) =>
          member.requestedInstanceId !== null &&
          member.requestedInstanceId !== member.providerInstanceId,
      )
      .map((member) => ({
        kind: "substitution" as const,
        at: member.startedAt,
        text: `${member.threadId} ran on ${member.providerInstanceId} instead of ${member.requestedInstanceId}`,
      })),
    ...prs.flatMap((row) => {
      const note = prDetail(row).ciNote;
      return note === null
        ? []
        : [{ kind: "ci" as const, at: null, text: `#${row.pr_number}: ${note}` }];
    }),
  ];

  let markdown = "";
  let truncated = false;
  if (run.reportPath !== null) {
    const bytes = yield* fs.readFile(run.reportPath).pipe(Effect.orElseSucceed(() => null));
    if (bytes !== null) {
      truncated = bytes.length > HOUSTON_NIGHT_REPORT_READ_BYTES;
      const kept = truncated ? bytes.subarray(0, HOUSTON_NIGHT_REPORT_READ_BYTES) : bytes;
      // A cut through a multi-byte character drops it rather than growing past the bound.
      markdown = new TextDecoder("utf-8", { fatal: false }).decode(kept).replace(/�$/, "");
    }
  }

  return {
    runId,
    headline: headline(prs.length, decisions.filter((row) => row.choice === null).length),
    summary: run.summary,
    decisions: {
      open: decisions.filter((row) => row.choice === null).map(decisionOf),
      answered: decisions.filter((row) => row.choice !== null).map(decisionOf),
    },
    pullRequests: [...groups].map(([theme, pullRequests]) => ({ theme, pullRequests })),
    mergeOrder: mergeOrder({
      pullRequests: prs.map((row) => ({ number: row.pr_number!, plans: prDetail(row).plans })),
      planDependencies: planDependencies(entries),
    }),
    picks,
    events,
    remoteChanges,
    cost: isCost(run.cost) ? run.cost : null,
    markdown,
    truncated,
  } satisfies HoustonNightReport;
});
