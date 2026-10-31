// What each open request is owed when its task or run changes in Houston: derived from the rows
// every 5 seconds and on each Tasks change, then queued in the outbox under a dedupe key.
import { houstonTaskKey } from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectService from "../../project/ProjectService.ts";
import * as TaskGit from "../tasks/TaskGit.ts";
import { HoustonTaskStore, nowIso, type RunRow } from "../tasks/TaskStore.ts";
import { OPEN_RUN_STATES } from "../tasks/rules.ts";
import { HoustonSlackConversation, projectRootOf, section } from "./Conversation.ts";
import { HoustonSlackIntake } from "./Intake.ts";
import {
  agentText,
  escapeMrkdwn,
  outboundText,
  readyThreadText,
  refusedThreadText,
  sizeCategory,
  type PostContext,
  type ResultForm,
} from "./rules.ts";
import { HoustonSlackStore, type RequestRow, type SettingsRow } from "./Store.ts";
import { slackText } from "./text.ts";

const TICK = Duration.seconds(5);

export class HoustonSlackReplies extends Context.Service<
  HoustonSlackReplies,
  { readonly tick: Effect.Effect<void> }
>()("houston/houston/slack/Replies/HoustonSlackReplies") {}

interface OwedRow extends RequestRow {
  readonly status: string | null;
  readonly archived_at: string | null;
  readonly number: number;
  readonly open_runs: number;
  readonly results: number;
}

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.Literals(["ready", "refused"]),
      subject: Schema.String,
      changes: Schema.String,
      steps: Schema.optional(Schema.Array(Schema.String)),
      caveats: Schema.optional(Schema.String),
      liveNote: Schema.optional(Schema.String),
      droppedNote: Schema.optional(Schema.String),
      size: Schema.optional(Schema.Literals(["small", "medium", "large"])),
      notes: Schema.optional(Schema.Array(Schema.String)),
      warnings: Schema.optional(Schema.Array(Schema.String)),
      blockers: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
);

const ms = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const intake = yield* HoustonSlackIntake;
  const conversation = yield* HoustonSlackConversation;
  const taskStore = yield* HoustonTaskStore;
  const projects = yield* ProjectService.ProjectService;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const queued = (key: string) =>
    run(sql<{ readonly one: number }>`
      SELECT 1 AS one FROM houston_slack_outbox WHERE dedupe_key = ${key}
    `).pipe(Effect.map((rows) => rows.length > 0));

  const latestRunOf = (taskId: number) =>
    run(sql<RunRow>`
      SELECT * FROM houston_task_runs WHERE task_id = ${taskId} AND kind = 'implementation'
      ORDER BY id DESC LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]));

  const resultOf = (runId: number) =>
    run(sql<{ readonly form_json: string }>`
      SELECT form_json FROM houston_slack_results WHERE task_run_id = ${runId}
    `).pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : decodeResult(rows[0].form_json))));

  const newestResult = (requestId: number) =>
    run(sql<{ readonly form_json: string; readonly task_run_id: number }>`
      SELECT form_json, task_run_id FROM houston_slack_results WHERE request_id = ${requestId}
      ORDER BY task_run_id DESC LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]));

  const contextOf = (row: OwedRow, branch: string | null, settings: SettingsRow | undefined) =>
    Effect.map(
      projectRootOf(row.project_id).pipe(
        Effect.provideService(ProjectService.ProjectService, projects),
      ),
      (root): PostContext => ({
        language: settings?.language ?? "en",
        root,
        key: houstonTaskKey(row.number),
        branch,
      }),
    );

  const ownerDm = (
    row: OwedRow,
    settings: SettingsRow | undefined,
    key: string,
    lines: ReadonlyArray<string>,
  ) => {
    const owner = settings?.owner_user_id;
    if (owner === null || owner === undefined) return Effect.void;
    const text = slackText(settings?.language ?? "en");
    const body = [text.newRequest(row.channel_id, row.author), ...lines].join("\n");
    return store.enqueue({
      requestId: row.id,
      dedupeKey: key,
      target: "dm",
      text: body,
      blocks: [section(body)],
      userId: owner,
    });
  };

  /** Minutes from the run's start to its hand-back, minus the time its questions waited. */
  const minutesWorked = Effect.fn("HoustonSlackReplies.minutesWorked")(function* (latest: RunRow) {
    const end = ms(latest.ended_at ?? (yield* nowIso));
    const questions = yield* run(sql<{
      readonly created_at: string;
      readonly answered_at: string | null;
    }>`SELECT created_at, answered_at FROM houston_slack_questions WHERE task_run_id = ${latest.id}`);
    const waited = questions.reduce(
      (sum, question) =>
        sum +
        Math.max(
          0,
          (question.answered_at === null ? end : ms(question.answered_at)) -
            ms(question.created_at),
        ),
      0,
    );
    return Math.max(0, Math.round((end - ms(latest.started_at) - waited) / 60_000));
  });

  /** The result's reply in the thread and its message to the owner, once per run. */
  const postResult = Effect.fn("HoustonSlackReplies.postResult")(function* (
    row: OwedRow,
    latest: RunRow,
    form: ResultForm,
    settings: SettingsRow | undefined,
  ) {
    const key = `result:${latest.id}`;
    if (yield* queued(key)) return;
    const text = slackText(settings?.language ?? "en");
    const context = yield* contextOf(row, latest.branch, settings);
    const owner = (value: string) => agentText(value, { root: context.root, hide: [] });
    const diff =
      latest.worktree_path === null || latest.base_commit === null
        ? null
        : yield* TaskGit.diffSize(latest.worktree_path, latest.base_commit, "HEAD").pipe(
            Effect.orElseSucceed(() => null),
          );
    const size = sizeCategory(form.size, diff);
    const minutes = yield* minutesWorked(latest);
    const list = (label: string, lines: ReadonlyArray<string> | undefined) =>
      lines === undefined || lines.length === 0
        ? []
        : [label, ...lines.map((line) => `• ${owner(line)}`)];
    const ready = form.outcome === "ready";
    const dm = ready
      ? [
          text.dmReady(owner(form.subject)),
          ...(size === null ? [] : [text.size(size)]),
          ...(latest.branch === null ? [] : [text.branch(escapeMrkdwn(latest.branch))]),
          ...(latest.pr_url === null ? [] : [text.pullRequest(outboundText(latest.pr_url))]),
          ...list(text.blockersLabel, form.blockers),
          ...list(text.warningsLabel, form.warnings),
          ...list(text.factsLabel, form.notes),
          text.workTime(minutes),
        ]
      : [text.dmRefused(owner(form.subject)), owner(form.changes)];
    const body = ready ? readyThreadText(form, context) : refusedThreadText(form, context);
    yield* store.write(
      Effect.gen(function* () {
        yield* store.enqueue({
          requestId: row.id,
          dedupeKey: key,
          target: "thread",
          text: body,
          blocks: [section(body)],
          messageTs: row.ts,
        });
        yield* store.react(row.id, ready ? "checkered_flag" : "no_entry_sign");
        yield* ownerDm(row, settings, `result-dm:${latest.id}`, dm);
        return { result: undefined, requests: [row.id] };
      }),
    );
  });

  /** A stopped, failed or waiting run tells the owner once and shows ⚠️. */
  const attention = Effect.fn("HoustonSlackReplies.attention")(function* (
    row: OwedRow,
    latest: RunRow,
    settings: SettingsRow | undefined,
  ) {
    const text = slackText(settings?.language ?? "en");
    const asking =
      (yield* run(sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM houston_slack_questions
        WHERE task_run_id = ${latest.id} AND (answered_at IS NULL OR delivered_at IS NULL)
      `))[0]?.n ?? 0;
    const what =
      latest.state === "cancelled" || latest.state === "interrupted"
        ? text.runStopped
        : latest.state === "failed"
          ? text.runFailed(outboundText(latest.reason ?? "no reason recorded"))
          : latest.state === "waiting_for_input" && asking === 0
            ? text.runWaiting
            : null;
    if (what === null) {
      // Working again after an attention mark: back to ⚙️, unless a question is open.
      if (
        OPEN_RUN_STATES.has(latest.state) &&
        latest.state !== "waiting_for_input" &&
        row.status_reaction === "warning" &&
        asking === 0
      ) {
        yield* store.write(
          store.react(row.id, "gear").pipe(Effect.as({ result: undefined, requests: [row.id] })),
        );
      }
      return;
    }
    const key = `attention:${latest.id}:${latest.state}`;
    if (yield* queued(key)) return;
    yield* store.write(
      Effect.gen(function* () {
        yield* store.react(row.id, "warning");
        yield* ownerDm(row, settings, key, [`${text.attention}: ${what}`]);
        return { result: undefined, requests: [row.id] };
      }),
    );
  });

  /** A handed-back or started task set done or canceled: its note once, pending adjustments end. */
  const close = Effect.fn("HoustonSlackReplies.close")(function* (
    row: OwedRow,
    settings: SettingsRow | undefined,
  ) {
    const text = slackText(settings?.language ?? "en");
    const done = row.status === "done";
    const newest = yield* newestResult(row.id);
    const form = newest === undefined ? undefined : decodeResult(newest.form_json);
    const latest = row.task_id === null ? undefined : yield* latestRunOf(row.task_id);
    const context = yield* contextOf(row, latest?.branch ?? null, settings);
    const pending = yield* run(sql<{ readonly id: number; readonly ts: string }>`
      SELECT id, ts FROM houston_slack_adjustments WHERE request_id = ${row.id} AND state = 'pending'
    `);
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`UPDATE houston_slack_requests SET state = 'closed' WHERE id = ${row.id}`);
        for (const adjustment of pending) {
          yield* run(sql`
            UPDATE houston_slack_adjustments SET state = 'refused' WHERE id = ${adjustment.id}
          `);
          yield* store.enqueue({
            requestId: row.id,
            dedupeKey: `adjust-closed:${adjustment.id}`,
            target: "react",
            text: "",
            removeReaction: "eyes",
            messageTs: adjustment.ts,
          });
        }
        if (form?.outcome === "ready") {
          const clean = (value: string) =>
            agentText(value, { root: context.root, hide: [context.key, context.branch ?? ""] });
          const note = done
            ? [
                form.liveNote === undefined ? text.liveDefault : clean(form.liveNote),
                text.anotherChange(settings?.bot_user_id ?? ""),
              ].join("\n")
            : form.droppedNote === undefined
              ? text.droppedDefault
              : clean(form.droppedNote);
          yield* store.enqueue({
            requestId: row.id,
            dedupeKey: `close-note:${row.id}`,
            target: "thread",
            text: note,
            blocks: [section(note)],
            messageTs: row.ts,
          });
        }
        // A refusal at triage keeps its 🚫 whatever the task's end.
        yield* store.react(
          row.id,
          form?.outcome === "refused" ? "no_entry_sign" : done ? "rocket" : "no_entry_sign",
        );
        return { result: undefined, requests: [row.id] };
      }),
    );
  });

  const derive = Effect.gen(function* () {
    const settings = yield* store.settings;
    const text = slackText(settings?.language ?? "en");
    const rows = yield* run(sql<OwedRow>`
      SELECT r.*, t.status AS status, t.archived_at AS archived_at, t.number AS number,
        (SELECT COUNT(*) FROM houston_task_runs
          WHERE task_id = r.task_id AND kind = 'implementation'
            AND state IN ('preparing', 'running', 'waiting_for_input', 'validating')) AS open_runs,
        (SELECT COUNT(*) FROM houston_slack_results WHERE request_id = r.id) AS results
      FROM houston_slack_requests r JOIN houston_tasks t ON t.id = r.task_id
      WHERE r.state IN ('pending', 'queued', 'started')
      ORDER BY r.id
    `);
    for (const row of rows) {
      const closed = row.status === "canceled" || row.status === "done" || row.archived_at !== null;
      const handedBack = row.results > 0;
      if ((row.state === "pending" || row.state === "queued") && !handedBack) {
        if (closed) {
          // Closed in Houston before it started: refused, and the owner's buttons go away.
          yield* store.write(
            Effect.gen(function* () {
              yield* run(sql`
                UPDATE houston_slack_requests SET state = 'refused', queued_at = NULL
                WHERE id = ${row.id}
              `);
              yield* store.react(row.id, "no_entry_sign");
              const body = `${text.newRequest(row.channel_id, row.author)}\n${text.closedInHouston}`;
              yield* store.enqueue({
                requestId: row.id,
                dedupeKey: `dm-closed:${row.id}`,
                target: "update",
                text: body,
                blocks: [section(body)],
                updateOf: `dm:${row.id}`,
              });
              return { result: undefined, requests: [row.id] };
            }),
          );
        } else if (row.open_runs > 0) {
          // Started from Houston: Start is the owner's acceptance.
          yield* store.write(
            Effect.gen(function* () {
              yield* run(sql`
                UPDATE houston_slack_requests SET state = 'started', queued_at = NULL
                WHERE id = ${row.id}
              `);
              if (row.state === "pending" && row.task_id !== null) {
                yield* taskStore.recordHistory(row.task_id, "user", "houston:slack-accepted", {
                  from: "houston",
                });
              }
              yield* store.react(row.id, "gear");
              return {
                result: undefined,
                touched: row.task_id === null ? [] : [row.task_id],
                requests: [row.id],
              };
            }),
          );
        }
        continue;
      }
      if (row.status === "done" || row.status === "canceled") {
        yield* close(row, settings);
        continue;
      }
      if (row.state !== "started" || row.task_id === null) continue;
      const latest = yield* latestRunOf(row.task_id);
      if (latest === undefined) continue;
      if (latest.state === "handed_back") {
        const form = yield* resultOf(latest.id);
        if (form !== undefined) yield* postResult(row, latest, form, settings);
        continue;
      }
      yield* attention(row, latest, settings);
    }
    yield* conversation.deliverAnswers;
    yield* intake.startQueued;
  });

  const tick = intake
    .withLock(derive)
    .pipe(Effect.catchCause((cause) => Effect.logWarning("Slack replies tick failed.", cause)));

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
  const changes = yield* PubSub.subscribe(taskStore.changes);
  yield* Stream.fromSubscription(changes).pipe(
    Stream.runForEach(() => tick),
    Effect.forkScoped,
  );

  return HoustonSlackReplies.of({ tick });
});

export const layer = Layer.effect(HoustonSlackReplies, make);
