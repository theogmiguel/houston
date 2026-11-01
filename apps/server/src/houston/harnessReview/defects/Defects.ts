// @effect-diagnostics nodeBuiltinImport:off - a report loses the user's home path before it is stored.
// Suspected defects agents report: redacted, deduplicated, stored in the thread's project, decided
// by the user and announced once a UTC day. Nothing here sends anything off the machine.
import * as NodeOS from "node:os";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  HoustonHarnessError,
  type HoustonDefectDecideInput,
  type HoustonDefectReportResult,
  type HoustonHarnessDefectDestination,
  type HoustonSuspectedDefect,
} from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import { HoustonHarnessStore, type DefectRow } from "../Store.ts";
import { redact } from "./redact.ts";
import { checkReport, defectKey, defectState, mergeEvidence, RECORDED_NOTE } from "./rules.ts";

const OPERATION = "houston_defect_report";
const textList = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const DECISIONS = {
  dismiss: { state: "dismissed", by: "user" },
  notABug: { state: "dismissed", by: "not_a_bug" },
  reopen: { state: "open", by: "user" },
} as const;

export interface DefectReport {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly description?: string | undefined;
  readonly evidence?: ReadonlyArray<string> | undefined;
  readonly destination: HoustonHarnessDefectDestination;
}

export class HoustonDefects extends Context.Service<
  HoustonDefects,
  {
    readonly report: (
      input: DefectReport,
    ) => Effect.Effect<HoustonDefectReportResult, HoustonHarnessError>;
    readonly decide: (input: HoustonDefectDecideInput) => Effect.Effect<void, HoustonHarnessError>;
    /** The project's defects as the snapshot shows them, newest report first. */
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<HoustonSuspectedDefect>>;
    readonly row: (
      projectId: ProjectId,
      key: string,
    ) => Effect.Effect<HoustonSuspectedDefect, HoustonHarnessError>;
  }
>()("houston/houston/harnessReview/defects/Defects/HoustonDefects") {}

const refuse = (kind: HoustonHarnessError["kind"], operation: string, message: string) =>
  new HoustonHarnessError({ kind, operation, message });

const toDefect = (
  row: DefectRow,
  decision: { readonly state: HoustonSuspectedDefect["state"]; readonly decidedAt: string } | null,
): HoustonSuspectedDefect => {
  const read = defectState(decision, row.last_seen_at);
  return {
    key: row.key,
    source: row.source,
    detector: row.detector,
    title: row.title,
    description: row.description,
    evidence: textList(row.evidence_json),
    destination: row.destination,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    count: row.count,
    issueUrl: row.issue_url,
    state: read.state,
    recurred: read.recurred,
  };
};

const make = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const projectOf = (operation: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : Effect.fail(refuse("not_found", operation, `project ${projectId} does not exist`)),
      ),
    );

  const list: HoustonDefects["Service"]["list"] = Effect.fn("HoustonDefects.list")(
    function* (projectId) {
      const decisions = new Map(
        (yield* store.decisions(projectId)).map((row) => [
          row.key,
          { state: row.state, decidedAt: row.decided_at },
        ]),
      );
      return (yield* store.defectRows(projectId)).map((row) =>
        toDefect(row, decisions.get(row.key) ?? null),
      );
    },
  );

  const row: HoustonDefects["Service"]["row"] = Effect.fn("HoustonDefects.row")(
    function* (projectId, key) {
      const found = (yield* list(projectId)).find((defect) => defect.key === key);
      if (found === undefined) {
        return yield* refuse(
          "not_found",
          "defects",
          `no suspected defect of project ${projectId} has the key "${key.slice(0, 200)}"`,
        );
      }
      return found;
    },
  );

  /** Announces the project's undecided defects once per UTC day; the day survives a restart. */
  const notice = Effect.fn("HoustonDefects.notice")(function* (projectId: ProjectId) {
    const undecided = (yield* list(projectId)).filter((defect) => defect.state === "open");
    const latest = undecided[0];
    if (latest === undefined) return;
    const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    if (!(yield* store.claimNoticeDay(projectId, day))) return;
    yield* PubSub.publish(store.notices, {
      projectId,
      count: undecided.length,
      title: latest.title,
    });
  });

  const report: HoustonDefects["Service"]["report"] = Effect.fn("HoustonDefects.report")(
    function* (input) {
      const refusal = checkReport(input);
      if (refusal !== null) return yield* refuse("invalid", OPERATION, refusal.message);
      const project = yield* projectOf(OPERATION, input.projectId);
      const clean = (text: string) => redact(text, project.workspaceRoot, NodeOS.homedir());
      const title = clean(input.title.trim());
      const evidence = (input.evidence ?? []).map(clean);
      const key = defectKey(input.destination, title);
      const at = DateTime.formatIso(yield* DateTime.now);
      const { count } = yield* store.recordDefect(
        {
          projectId: input.projectId,
          key,
          title,
          description: clean(input.description ?? ""),
          evidence,
          destination: input.destination,
          threadId: input.threadId,
          at,
        },
        (stored) => mergeEvidence(stored, evidence),
      );
      yield* notice(input.projectId);
      return { recorded: true as const, key, count, note: RECORDED_NOTE };
    },
  );

  const decide: HoustonDefects["Service"]["decide"] = Effect.fn("HoustonDefects.decide")(
    function* (input) {
      yield* projectOf("defects.decide", input.projectId);
      yield* row(input.projectId, input.key);
      const decision = DECISIONS[input.decision];
      yield* store.decide({
        projectId: input.projectId,
        key: input.key,
        state: decision.state,
        by: decision.by,
      });
    },
  );

  return HoustonDefects.of({ report, decide, list, row });
});

export const layer = Layer.effect(HoustonDefects, make);
