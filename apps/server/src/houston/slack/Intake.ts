// @effect-diagnostics nodeBuiltinImport:off - stores a request's images in the attachments folder.
// What Slack events and clicks do: a mention files a pending task, the owner's ✅, Accept or
// Start begins it under the working cap, Refuse cancels it. One operation runs at a time.
import * as NodePath from "node:path";

import { ChatAttachment } from "@t3tools/contracts";
import { HOUSTON_SLACK_LIMITS, type HoustonSlackLanguage } from "@t3tools/contracts/houston/slack";
import { houstonTaskKey } from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { attachmentRelativePath, createAttachmentId } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { HoustonTaskRuns } from "../tasks/TaskRuns.ts";
import { HoustonTaskService } from "../tasks/TaskService.ts";
import { HoustonTaskStore, nowIso, type RunRow, type TaskRow } from "../tasks/TaskStore.ts";
import { OPEN_RUN_STATES } from "../tasks/rules.ts";
import {
  ANSWER_ACTION,
  ANSWER_CALLBACK,
  HoustonSlackConversation,
  OTHER_ANSWER_ACTION,
} from "./Conversation.ts";
import {
  ACCEPT_ACTION,
  ADJUST_ACCEPT_ACTION,
  ADJUST_IGNORE_ACTION,
  answerAllowed,
  CHECK_MARK,
  REFUSE_ACTION,
  REFUSE_CALLBACK,
  VIEW_ACTION,
  admit,
  checkRequestText,
  classifyEvent,
  escapeMrkdwn,
  outboundText,
  isSlackFileUrl,
  ownerAccepts,
  sniffImage,
  titleOf,
  workingCount,
  type Classified,
  type SlackContext,
  type SlackFile,
} from "./rules.ts";
import { HoustonSlackStore, type RequestRow, type SettingsRow } from "./Store.ts";
import { slackText, type LeftOutReason } from "./text.ts";
import { SlackWebApi } from "./WebApi.ts";

type RequestEvent = Extract<Classified, { kind: "request" }>;

export class HoustonSlackIntake extends Context.Service<
  HoustonSlackIntake,
  {
    /** A live event or a replayed history message. */
    readonly event: (
      event: unknown,
      botToken: Redacted.Redacted<string>,
      source: "live" | "history",
    ) => Effect.Effect<void>;
    /** A button click or a dialog submission. */
    readonly interaction: (
      payload: unknown,
      botToken: Redacted.Redacted<string>,
    ) => Effect.Effect<void>;
    /** The owner's ✅ found on a filed request during catch-up. */
    readonly acceptAt: (channel: string, ts: string) => Effect.Effect<void>;
    /** Runs `effect` alone among the intake's operations. */
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Starts queued requests, oldest acceptance first, while a slot is free. Inside `withLock`. */
    readonly startQueued: Effect.Effect<void>;
    /** Started requests that hold a working slot. */
    readonly working: Effect.Effect<number>;
  }
>()("houston/houston/slack/Intake/HoustonSlackIntake") {}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const encodeAttachments = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChatAttachment)));
const decodeOptions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ options: Schema.Array(Schema.String) })),
);

interface AdjustmentRow {
  readonly id: number;
  readonly request_id: number;
  readonly task_run_id: number;
  readonly ts: string;
  readonly text: string;
  readonly state: "pending" | "accepted" | "refused";
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const web = yield* SlackWebApi;
  const tasks = yield* HoustonTaskService;
  const taskStore = yield* HoustonTaskStore;
  const runs = yield* HoustonTaskRuns;
  const conversation = yield* HoustonSlackConversation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect);

  const contextOf = (settings: SettingsRow | undefined) =>
    Effect.map(store.channels, (channels) =>
      settings?.bot_user_id === null ||
      settings?.bot_user_id === undefined ||
      settings.team_id === null
        ? null
        : ({
            botUserId: settings.bot_user_id,
            teamId: settings.team_id,
            channels: new Set(channels.map((channel) => channel.channel_id)),
          } satisfies SlackContext),
    );

  const language = (settings: SettingsRow | undefined): HoustonSlackLanguage =>
    settings?.language ?? "en";

  const working = Effect.gen(function* () {
    const rows = yield* run(sql<{ readonly run_state: string | null; readonly asking: number }>`
      SELECT
        (SELECT state FROM houston_task_runs
          WHERE task_id = r.task_id AND kind = 'implementation' ORDER BY id DESC LIMIT 1) AS run_state,
        (SELECT COUNT(*) FROM houston_slack_questions q
          WHERE q.request_id = r.id AND q.answered_at IS NULL) AS asking
      FROM houston_slack_requests r WHERE r.state = 'started'
    `);
    return workingCount(
      rows.map((row) => ({
        open: row.run_state !== null && OPEN_RUN_STATES.has(row.run_state as never),
        awaitingAnswer: row.asking > 0,
      })),
    );
  });

  const ownerDm = Effect.fn("HoustonSlackIntake.ownerDm")(function* (
    request: RequestRow,
    settings: SettingsRow | undefined,
    prefix: string,
    lines: ReadonlyArray<string>,
  ) {
    const owner = settings?.owner_user_id;
    if (owner === null || owner === undefined) return;
    const text = slackText(language(settings));
    const body = [text.newRequest(request.channel_id, request.author), ...lines].join("\n");
    yield* store.enqueue({
      requestId: request.id,
      dedupeKey: yield* store.nextKey(prefix),
      target: "dm",
      text: body,
      blocks: [section(body)],
      userId: owner,
    });
  });

  // Filing.

  const collectImages = Effect.fn("HoustonSlackIntake.collectImages")(function* (
    requestId: number,
    files: ReadonlyArray<SlackFile>,
    botToken: Redacted.Redacted<string>,
  ) {
    const kept: Array<ChatAttachment> = [];
    const leftOut: Array<{ readonly name: string; readonly reason: LeftOutReason }> = [];
    // Downloads are counted, kept or not, so a mention fetches at most `images` files.
    let fetched = 0;
    for (const file of files) {
      if (fetched >= HOUSTON_SLACK_LIMITS.images) {
        leftOut.push({ name: file.name, reason: "count" });
        continue;
      }
      if (file.url === null || !isSlackFileUrl(file.url, web.allowLoopback)) {
        leftOut.push({ name: file.name, reason: "host" });
        continue;
      }
      fetched += 1;
      const downloaded = yield* Effect.result(
        web.download(botToken, file.url, HOUSTON_SLACK_LIMITS.imageBytes),
      );
      if (downloaded._tag === "Failure") {
        leftOut.push({ name: file.name, reason: "failed" });
        continue;
      }
      if (downloaded.success.truncated) {
        leftOut.push({ name: file.name, reason: "size" });
        continue;
      }
      const mimeType = sniffImage(downloaded.success.bytes);
      const id =
        mimeType === null
          ? null
          : createAttachmentId(`slack-request-${requestId}`, EXTENSIONS[mimeType]);
      if (mimeType === null || id === null) {
        leftOut.push({ name: file.name, reason: "type" });
        continue;
      }
      const attachment: ChatAttachment = {
        type: "image",
        id,
        name: (file.name.trim() || "image").slice(0, 255),
        mimeType,
        sizeBytes: downloaded.success.bytes.byteLength,
      };
      const relative = attachmentRelativePath(attachment);
      if (relative === null) {
        leftOut.push({ name: file.name, reason: "type" });
        continue;
      }
      const stored = yield* fs
        .makeDirectory(config.attachmentsDir, { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFile(NodePath.join(config.attachmentsDir, relative), downloaded.success.bytes),
          ),
          Effect.result,
        );
      if (stored._tag === "Failure") {
        leftOut.push({ name: file.name, reason: "failed" });
        continue;
      }
      kept.push(attachment);
    }
    return { kept, leftOut };
  });

  const permalinkOf = (botToken: Redacted.Redacted<string>, channel: string, ts: string) =>
    web.call(botToken, "chat.getPermalink", { channel, message_ts: ts }).pipe(
      Effect.map((answer) => str(answer.permalink) ?? null),
      Effect.catch((error) =>
        Effect.logWarning(`Slack permalink of ${channel} ${ts} failed: ${error.message}`).pipe(
          Effect.as(null),
        ),
      ),
    );

  /** Files `request` (a mention, or the requester's reply that replaces an unfiled mention). */
  const file = Effect.fn("HoustonSlackIntake.file")(function* (
    request: RequestEvent,
    botToken: Redacted.Redacted<string>,
    existing?: RequestRow,
  ) {
    const settings = yield* store.settings;
    const text = slackText(language(settings));
    const channel = (yield* store.channels).find((entry) => entry.channel_id === request.channel);
    if (channel === undefined) return;
    let row = existing;
    if (row === undefined) {
      const now = yield* nowIso;
      const inserted = yield* store.write(
        run(sql<RequestRow>`
          INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
          VALUES (${request.channel}, ${request.ts}, ${request.user}, ${channel.project_id},
            'pending', ${now})
          ON CONFLICT (channel_id, ts) DO NOTHING RETURNING *
        `).pipe(Effect.map((rows) => ({ result: rows[0] }))),
      );
      // A redelivered or replayed mention files nothing.
      if (inserted === undefined) return;
      row = inserted;
    }
    const current = row;
    const bot = settings?.bot_user_id ?? "";
    const problem = checkRequestText(request.text);
    if (problem !== null) {
      yield* store.write(
        Effect.gen(function* () {
          yield* run(sql`
            UPDATE houston_slack_requests SET state = 'refused', task_id = NULL, awaiting_reply = 1
            WHERE id = ${current.id}
          `);
          yield* store.react(current.id, "warning");
          yield* store.enqueue({
            requestId: current.id,
            dedupeKey: `unfiled-thread:${current.id}:${request.ts}`,
            target: "thread",
            text:
              problem.problem === "empty" ? text.emptyRequestReply(bot) : text.tooLongReply(bot),
            messageTs: current.ts,
          });
          yield* ownerDm(current, settings, `unfiled-dm:${current.id}`, [
            `${text.attention}: ${text.notFiled(problem.problem === "empty" ? text.emptyRequest : text.tooLong(problem.bytes))}`,
          ]);
          return { result: undefined, requests: [current.id] };
        }),
      );
      return;
    }
    // A disconnect during Slack's calls files nothing; a new mention row is dropped so a later
    // catch-up can file it.
    const disconnected = Effect.gen(function* () {
      if ((yield* store.settings)?.enabled === 1) return false;
      if (existing === undefined) {
        yield* store.write(
          run(sql`DELETE FROM houston_slack_requests WHERE id = ${current.id}`).pipe(
            Effect.as({ result: undefined }),
          ),
        );
      }
      return true;
    });
    const permalink = yield* permalinkOf(botToken, request.channel, current.ts);
    if (yield* disconnected) return;
    const images = yield* collectImages(current.id, request.files, botToken);
    if (yield* disconnected) return;
    const created = yield* Effect.result(
      tasks.save(
        {
          patch: {
            title: titleOf(request.text),
            description: request.text,
            projectId: channel.project_id as never,
            refUrl: permalink,
            status: "todo",
          },
        },
        `slack:${request.user}`,
      ),
    );
    if (created._tag === "Failure") {
      yield* store.write(
        Effect.gen(function* () {
          yield* run(sql`
            UPDATE houston_slack_requests SET state = 'refused', awaiting_reply = 0,
              permalink = ${permalink} WHERE id = ${current.id}
          `);
          yield* store.react(current.id, "warning");
          yield* ownerDm(current, settings, `refused-filing:${current.id}`, [
            `${text.attention}: ${text.notFiled(outboundText(created.failure.message))}`,
          ]);
          return { result: undefined, requests: [current.id] };
        }),
      );
      return;
    }
    const task = created.success;
    const outlook = text.startOutlook(yield* working);
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_requests SET task_id = ${task.id}, state = 'pending',
            awaiting_reply = 0, permalink = ${permalink},
            attachments_json = ${images.kept.length === 0 ? null : encodeAttachments(images.kept)}
          WHERE id = ${current.id}
        `);
        yield* taskStore.recordHistory(task.id, `slack:${request.user}`, "houston:slack-filed", {
          channel: request.channel,
          ts: current.ts,
          permalink,
        });
        yield* store.react(current.id, "eyes");
        const owner = settings?.owner_user_id;
        if (owner !== null && owner !== undefined) {
          const quote = escapeMrkdwn(
            [...request.text].slice(0, HOUSTON_SLACK_LIMITS.previewChars).join(""),
          )
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          const lines = [
            text.newRequest(request.channel, request.user),
            quote,
            `${text.start}: ${outlook}`,
            ...(images.leftOut.length === 0
              ? []
              : [
                  text.leftOutHeading,
                  ...images.leftOut.map(
                    (entry) => `• ${escapeMrkdwn(entry.name)}: ${text.leftOut(entry.reason)}`,
                  ),
                ]),
          ];
          const body = lines.join("\n");
          yield* store.enqueue({
            requestId: current.id,
            dedupeKey: `dm:${current.id}`,
            target: "dm",
            text: body,
            blocks: [
              section(body),
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    action_id: ACCEPT_ACTION,
                    style: "primary",
                    value: String(current.id),
                    text: { type: "plain_text", text: text.accept },
                  },
                  {
                    type: "button",
                    action_id: REFUSE_ACTION,
                    style: "danger",
                    value: String(current.id),
                    text: { type: "plain_text", text: text.refuse },
                  },
                  ...(permalink === null
                    ? []
                    : [
                        {
                          type: "button",
                          action_id: VIEW_ACTION,
                          url: permalink,
                          text: { type: "plain_text", text: text.viewMessage },
                        },
                      ]),
                ],
              },
            ],
            userId: owner,
          });
        }
        return { result: undefined, touched: [task.id], requests: [current.id] };
      }),
    );
  });

  // Acceptance.

  /** The owner's DM, edited to say what happened, without its buttons. */
  const closeDm = Effect.fn("HoustonSlackIntake.closeDm")(function* (
    request: RequestRow,
    settings: SettingsRow | undefined,
    note: string,
  ) {
    const text = slackText(language(settings));
    const body = `${text.newRequest(request.channel_id, request.author)}\n${note}`;
    yield* store.enqueue({
      requestId: request.id,
      dedupeKey: yield* store.nextKey(`dm-update:${request.id}`),
      target: "update",
      text: body,
      blocks: [section(body)],
      updateOf: `dm:${request.id}`,
    });
  });

  const latestRunOf = (taskId: number) =>
    run(sql<RunRow>`
      SELECT * FROM houston_task_runs WHERE task_id = ${taskId} AND kind = 'implementation'
      ORDER BY id DESC LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]));

  /** The accepted adjustment a request waits to start, with the handed-back run it adjusts. */
  const adjustmentToStart = Effect.fn("HoustonSlackIntake.adjustmentToStart")(function* (
    request: RequestRow,
  ) {
    if (request.task_id === null) return undefined;
    const latest = yield* latestRunOf(request.task_id);
    if (latest === undefined || latest.state !== "handed_back") return undefined;
    const [adjustment] = yield* run(sql<AdjustmentRow>`
      SELECT * FROM houston_slack_adjustments
      WHERE request_id = ${request.id} AND task_run_id = ${latest.id} AND state = 'accepted'
      ORDER BY id DESC LIMIT 1
    `);
    return adjustment === undefined ? undefined : { adjustment, run: latest };
  });

  /** A new attempt on the adjusted run's branch; its brief carries the accepted adjustments. */
  const startAdjustment = Effect.fn("HoustonSlackIntake.startAdjustment")(function* (
    request: RequestRow,
    previous: RunRow,
    adjustment: AdjustmentRow,
    settings: SettingsRow | undefined,
  ) {
    const text = slackText(language(settings));
    const started = yield* Effect.result(runs.runControl({ runId: previous.id, action: "resume" }));
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_requests SET state = 'started', queued_at = NULL
          WHERE id = ${request.id}
        `);
        if (started._tag === "Failure") {
          yield* store.react(request.id, "warning");
          yield* ownerDm(request, settings, `adjust-failed:${adjustment.id}`, [
            `${text.attention}: ${text.couldNotStart(outboundText(started.failure.message))}`,
          ]);
        } else {
          yield* store.react(request.id, "gear");
          yield* adjustmentDmUpdate(request, adjustment, settings, text.adjustmentStarted);
        }
        return { result: undefined, requests: [request.id] };
      }),
    );
  });

  const startRequest = Effect.fn("HoustonSlackIntake.startRequest")(function* (
    request: RequestRow,
    task: TaskRow,
    settings: SettingsRow | undefined,
  ) {
    const text = slackText(language(settings));
    const pendingAttempt = yield* adjustmentToStart(request);
    if (pendingAttempt !== undefined) {
      return yield* startAdjustment(
        request,
        pendingAttempt.run,
        pendingAttempt.adjustment,
        settings,
      );
    }
    const started = yield* Effect.result(runs.start({ id: houstonTaskKey(task.number) }));
    if (started._tag === "Failure") {
      yield* store.write(
        Effect.gen(function* () {
          yield* run(sql`
            UPDATE houston_slack_requests SET state = 'pending', queued_at = NULL
            WHERE id = ${request.id}
          `);
          yield* store.react(request.id, "warning");
          yield* ownerDm(request, settings, `start-failed:${request.id}`, [
            `${text.attention}: ${text.couldNotStart(outboundText(started.failure.message))}`,
          ]);
          return { result: undefined, requests: [request.id] };
        }),
      );
      return;
    }
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_requests SET state = 'started', queued_at = NULL
          WHERE id = ${request.id}
        `);
        if (request.state === "pending") {
          yield* taskStore.recordHistory(
            task.id,
            `slack:${settings?.owner_user_id ?? "owner"}`,
            "houston:slack-accepted",
            {},
          );
        }
        yield* store.react(request.id, "gear");
        yield* closeDm(request, settings, text.acceptedStarted);
        return { result: undefined, touched: [task.id], requests: [request.id] };
      }),
    );
  });

  const accept = Effect.fn("HoustonSlackIntake.accept")(function* (request: RequestRow) {
    if (request.state !== "pending" || request.task_id === null) return;
    const task = yield* taskStore.taskById(request.task_id);
    if (task === undefined) return;
    const settings = yield* store.settings;
    const text = slackText(language(settings));
    const readiness = (yield* taskStore.domain(task)).readiness;
    if (!readiness.ready) {
      yield* store.write(
        Effect.gen(function* () {
          yield* store.react(request.id, "warning");
          yield* ownerDm(request, settings, `unready:${request.id}`, [
            `${text.attention}: ${text.notReady(readiness.reasons)}`,
          ]);
          return { result: undefined, requests: [request.id] };
        }),
      );
      return;
    }
    if (admit(yield* working) === "queue") {
      const now = yield* nowIso;
      yield* store.write(
        Effect.gen(function* () {
          yield* run(sql`
            UPDATE houston_slack_requests SET state = 'queued', queued_at = ${now}
            WHERE id = ${request.id}
          `);
          yield* taskStore.recordHistory(
            task.id,
            `slack:${settings?.owner_user_id ?? "owner"}`,
            "houston:slack-accepted",
            { queued: true },
          );
          const [position] = yield* run(sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM houston_slack_requests
            WHERE state = 'queued'
              AND (queued_at < ${now} OR (queued_at = ${now} AND id <= ${request.id}))
          `);
          yield* ownerDm(request, settings, `queued:${request.id}`, [
            text.acceptedQueued(position?.n ?? 1),
          ]);
          return { result: undefined, touched: [task.id], requests: [request.id] };
        }),
      );
      return;
    }
    yield* startRequest(request, task, settings);
  });

  const startQueued = Effect.gen(function* () {
    const settings = yield* store.settings;
    for (;;) {
      if (admit(yield* working) === "queue") return;
      const [next] = yield* run(sql<RequestRow>`
        SELECT * FROM houston_slack_requests WHERE state = 'queued'
        ORDER BY queued_at, id LIMIT 1
      `);
      if (next === undefined || next.task_id === null) return;
      const task = yield* taskStore.taskById(next.task_id);
      if (task === undefined) return;
      yield* startRequest(next, task, settings);
    }
  });

  // Refusal.

  const refuseRequest = Effect.fn("HoustonSlackIntake.refuseRequest")(function* (
    request: RequestRow,
    reason: string,
    owner: string,
  ) {
    if ((request.state !== "pending" && request.state !== "queued") || request.task_id === null) {
      return;
    }
    const settings = yield* store.settings;
    const text = slackText(language(settings));
    const task = yield* taskStore.taskById(request.task_id);
    if (task !== undefined && task.status !== "canceled") {
      yield* tasks
        .save(
          {
            id: houstonTaskKey(task.number),
            expectedRevision: task.revision,
            patch: { status: "canceled" },
          },
          `slack:${owner}`,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Canceling the task of a refused Slack request failed: ${error.message}`,
            ),
          ),
        );
    }
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_requests SET state = 'refused', queued_at = NULL
          WHERE id = ${request.id}
        `);
        if (task !== undefined) {
          yield* taskStore.recordHistory(task.id, `slack:${owner}`, "houston:slack-refused", {
            reason: reason.length > 0,
          });
        }
        yield* store.react(request.id, "no_entry_sign");
        if (reason.length > 0) {
          const body = `${text.notGoingAhead}\n${escapeMrkdwn(reason)}\n_${text.reasonBy(owner)}_`;
          yield* store.enqueue({
            requestId: request.id,
            dedupeKey: `refused:${request.id}`,
            target: "thread",
            text: body,
            blocks: [section(body)],
            messageTs: request.ts,
          });
        }
        yield* closeDm(request, settings, text.refusedByOwner);
        return {
          result: undefined,
          touched: task === undefined ? [] : [task.id],
          requests: [request.id],
        };
      }),
    );
  });

  // Entry points.

  const ephemeral = Effect.fn("HoustonSlackIntake.ephemeral")(function* (
    request: RequestRow,
    channel: string,
    user: string,
    key: string,
    notice?: string,
  ) {
    const settings = yield* store.settings;
    yield* store.write(
      store
        .enqueue({
          requestId: request.id,
          dedupeKey: `ephemeral:${request.id}:${user}:${key}`,
          target: "ephemeral",
          text: notice ?? slackText(language(settings)).onlyOwner,
          userId: user,
          channel,
        })
        .pipe(Effect.as({ result: undefined })),
    );
  });

  const reply = Effect.fn("HoustonSlackIntake.reply")(function* (
    classified: Extract<Classified, { kind: "reply" }>,
    botToken: Redacted.Redacted<string>,
  ) {
    const request = yield* store.requestAt(classified.channel, classified.threadTs);
    if (request === undefined) return;
    // The requester's next reply replaces a mention whose text could not be filed.
    if (request.awaiting_reply === 1 && classified.user === request.author) {
      yield* file(
        {
          kind: "request",
          channel: classified.channel,
          ts: request.ts,
          user: classified.user,
          text: classified.text,
          files: classified.files,
        },
        botToken,
        request,
      );
      return;
    }
    const settings = yield* store.settings;
    // Only the requester's or the owner's reply answers, joins the task or becomes an adjustment.
    const fromRequesterOrOwner = answerAllowed({
      user: classified.user,
      requester: request.author,
      ownerUserId: settings?.owner_user_id ?? null,
    });
    if (!fromRequesterOrOwner || classified.text.length === 0) return;
    // Reply text is held to the dialog's bound wherever it goes.
    const chars = [...classified.text].length;
    if (chars > HOUSTON_SLACK_LIMITS.dialogChars) {
      return yield* ephemeral(
        request,
        classified.channel,
        classified.user,
        `too-long:${classified.ts}`,
        slackText(language(settings)).replyTooLong(chars),
      );
    }
    // While a question is open, the requester's or owner's next reply is its answer.
    const question = yield* conversation.openQuestion(request.id);
    if (question !== undefined) {
      yield* conversation.answer(question, classified.user, classified.text, classified.ts);
      return;
    }
    if (request.task_id === null) return;
    if (request.state === "pending" || request.state === "queued") {
      return yield* complement(request, classified, settings);
    }
    if (request.state !== "started") return;
    const latest = yield* latestRunOf(request.task_id);
    const task = yield* taskStore.taskById(request.task_id);
    if (latest?.state === "handed_back" && task?.status === "in_review") {
      return yield* requestAdjustment(request, latest, classified, settings);
    }
    // The owner is not told about their own reply during the work.
    if (
      latest !== undefined &&
      OPEN_RUN_STATES.has(latest.state) &&
      classified.user === request.author
    ) {
      yield* midWork(request, classified, settings);
    }
  });

  // Replies and adjustments.

  const queued = (key: string) =>
    run(sql<{ readonly one: number }>`
      SELECT 1 AS one FROM houston_slack_outbox WHERE dedupe_key = ${key}
    `).pipe(Effect.map((rows) => rows.length > 0));

  const quote = (value: string) =>
    escapeMrkdwn(value)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

  /** 👀 on a reply, outside the request's one status reaction. */
  const seen = (request: RequestRow, key: string, ts: string) =>
    store.enqueue({
      requestId: request.id,
      dedupeKey: key,
      target: "react",
      text: "",
      reaction: "eyes",
      removeReaction: null,
      messageTs: ts,
    });

  /** Before the work: the reply joins the task's description under a dated line. */
  const complement = Effect.fn("HoustonSlackIntake.complement")(function* (
    request: RequestRow,
    classified: Extract<Classified, { kind: "reply" }>,
    settings: SettingsRow | undefined,
  ) {
    const key = `reply-seen:${request.id}:${classified.ts}`;
    if (yield* queued(key)) return;
    const task = request.task_id === null ? undefined : yield* taskStore.taskById(request.task_id);
    if (task === undefined) return;
    const date = (yield* nowIso).slice(0, 10);
    const added = slackText(language(settings)).addedInSlack(date);
    const saved = yield* Effect.result(
      tasks.save(
        {
          id: houstonTaskKey(task.number),
          expectedRevision: task.revision,
          patch: { description: `${task.description}\n\n${added}\n${classified.text}` },
        },
        `slack:${classified.user}`,
      ),
    );
    if (saved._tag === "Failure") {
      yield* Effect.logWarning(
        `A Slack reply could not join ${houstonTaskKey(task.number)}: ${saved.failure.message}`,
      );
      // The owner hears it once per reply, so a replay does not repeat the message.
      const prefix = `reply-not-joined:${request.id}:${classified.ts}`;
      if (yield* queued(`${prefix}:1`)) return;
      const text = slackText(language(settings));
      yield* store.write(
        ownerDm(request, settings, prefix, [
          `${text.attention}: ${text.replyNotJoined(outboundText(saved.failure.message))}`,
          quote([...classified.text].slice(0, HOUSTON_SLACK_LIMITS.previewChars).join("")),
        ]).pipe(Effect.as({ result: undefined, requests: [request.id] })),
      );
      return;
    }
    yield* store.write(
      seen(request, key, classified.ts).pipe(Effect.as({ result: undefined })),
    );
  });

  /** During the work: the owner hears it; the agent does not. */
  const midWork = Effect.fn("HoustonSlackIntake.midWork")(function* (
    request: RequestRow,
    classified: Extract<Classified, { kind: "reply" }>,
    settings: SettingsRow | undefined,
  ) {
    const owner = settings?.owner_user_id;
    if (owner === null || owner === undefined) return;
    const text = slackText(language(settings));
    const body = [
      text.newRequest(request.channel_id, request.author),
      text.midWork,
      quote(classified.text),
      `_${text.midWorkHint}_`,
    ].join("\n");
    yield* store.write(
      Effect.gen(function* () {
        yield* seen(request, `reply-seen:${request.id}:${classified.ts}`, classified.ts);
        yield* store.enqueue({
          requestId: request.id,
          dedupeKey: `mid-work:${request.id}:${classified.ts}`,
          target: "dm",
          text: body,
          blocks: [section(body)],
          userId: owner,
        });
        return { result: undefined };
      }),
    );
  });

  /** After the hand-back: an adjustment the owner accepts into a new attempt or ignores. */
  const requestAdjustment = Effect.fn("HoustonSlackIntake.requestAdjustment")(function* (
    request: RequestRow,
    adjusted: RunRow,
    classified: Extract<Classified, { kind: "reply" }>,
    settings: SettingsRow | undefined,
  ) {
    const text = slackText(language(settings));
    const owner = settings?.owner_user_id;
    const now = yield* nowIso;
    yield* store.write(
      Effect.gen(function* () {
        const [row] = yield* run(sql<{ readonly id: number }>`
          INSERT INTO houston_slack_adjustments (request_id, task_run_id, ts, text, state, created_at)
          VALUES (${request.id}, ${adjusted.id}, ${classified.ts}, ${classified.text}, 'pending', ${now})
          ON CONFLICT (request_id, ts) DO NOTHING RETURNING id
        `);
        if (row === undefined) return { result: undefined };
        yield* seen(request, `adjust-seen:${row.id}`, classified.ts);
        if (owner !== null && owner !== undefined) {
          const body = [
            text.newRequest(request.channel_id, request.author),
            text.adjustmentTitle,
            quote(classified.text),
          ].join("\n");
          yield* store.enqueue({
            requestId: request.id,
            dedupeKey: `dm-adjust:${row.id}`,
            target: "dm",
            text: body,
            blocks: [
              section(body),
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    action_id: ADJUST_ACCEPT_ACTION,
                    style: "primary",
                    value: String(row.id),
                    text: { type: "plain_text", text: text.accept },
                  },
                  {
                    type: "button",
                    action_id: ADJUST_IGNORE_ACTION,
                    value: String(row.id),
                    text: { type: "plain_text", text: text.ignore },
                  },
                ],
              },
            ],
            userId: owner,
          });
        }
        return { result: undefined, requests: [request.id] };
      }),
    );
  });

  /** The owner's message about an adjustment, edited to say what happened, without buttons. */
  const adjustmentDmUpdate = (
    request: RequestRow,
    adjustment: AdjustmentRow,
    settings: SettingsRow | undefined,
    note: string,
  ) => {
    const text = slackText(language(settings));
    const body = [
      text.newRequest(request.channel_id, request.author),
      text.adjustmentTitle,
      quote(adjustment.text),
      note,
    ].join("\n");
    return store.enqueue({
      requestId: request.id,
      dedupeKey: `dm-adjust-update:${adjustment.id}`,
      target: "update",
      text: body,
      blocks: [section(body)],
      updateOf: `dm-adjust:${adjustment.id}`,
    });
  };

  const adjustmentById = (id: number) =>
    run(sql<AdjustmentRow>`SELECT * FROM houston_slack_adjustments WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const adjustmentAt = (channel: string, ts: string) =>
    run(sql<AdjustmentRow>`
      SELECT a.* FROM houston_slack_adjustments a
      JOIN houston_slack_requests r ON r.id = a.request_id
      WHERE r.channel_id = ${channel} AND a.ts = ${ts}
    `).pipe(Effect.map((rows) => rows[0]));

  const acceptAdjustment = Effect.fn("HoustonSlackIntake.acceptAdjustment")(function* (
    adjustment: AdjustmentRow,
  ) {
    if (adjustment.state !== "pending") return;
    const request = yield* store.requestById(adjustment.request_id);
    if (request === undefined || request.task_id === null) return;
    const latest = yield* latestRunOf(request.task_id);
    if (latest?.id !== adjustment.task_run_id || latest.state !== "handed_back") return;
    const settings = yield* store.settings;
    const accepted = { ...adjustment, state: "accepted" as const };
    if (admit(yield* working) === "queue") {
      const now = yield* nowIso;
      yield* store.write(
        Effect.gen(function* () {
          yield* run(sql`
            UPDATE houston_slack_adjustments SET state = 'accepted' WHERE id = ${adjustment.id}
          `);
          yield* run(sql`
            UPDATE houston_slack_requests SET state = 'queued', queued_at = ${now}
            WHERE id = ${request.id}
          `);
          const [position] = yield* run(sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM houston_slack_requests
            WHERE state = 'queued'
              AND (queued_at < ${now} OR (queued_at = ${now} AND id <= ${request.id}))
          `);
          yield* adjustmentDmUpdate(
            request,
            accepted,
            settings,
            slackText(language(settings)).acceptedQueued(position?.n ?? 1),
          );
          return { result: undefined, requests: [request.id] };
        }),
      );
      return;
    }
    yield* store.write(
      run(sql`
        UPDATE houston_slack_adjustments SET state = 'accepted' WHERE id = ${adjustment.id}
      `).pipe(Effect.as({ result: undefined })),
    );
    yield* startAdjustment(request, latest, accepted, settings);
  });

  const ignoreAdjustment = Effect.fn("HoustonSlackIntake.ignoreAdjustment")(function* (
    adjustment: AdjustmentRow,
  ) {
    if (adjustment.state !== "pending") return;
    const request = yield* store.requestById(adjustment.request_id);
    if (request === undefined) return;
    const settings = yield* store.settings;
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_adjustments SET state = 'refused' WHERE id = ${adjustment.id}
        `);
        yield* store.enqueue({
          requestId: request.id,
          dedupeKey: `adjust-unseen:${adjustment.id}`,
          target: "react",
          text: "",
          removeReaction: "eyes",
          messageTs: adjustment.ts,
        });
        yield* adjustmentDmUpdate(
          request,
          adjustment,
          settings,
          slackText(language(settings)).ignored,
        );
        return { result: undefined };
      }),
    );
  });

  // Answers by button and dialog.

  const questionOf = (id: number) =>
    run(sql<{ readonly id: number; readonly request_id: number; readonly form_json: string }>`
      SELECT id, request_id, form_json FROM houston_slack_questions WHERE id = ${id}
    `).pipe(Effect.map((rows) => rows[0]));

  const optionOf = (formJson: string, index: number): string | undefined => {
    const options = decodeOptions(formJson).options;
    return options[index];
  };

  const event: HoustonSlackIntake["Service"]["event"] = (raw, botToken, source) =>
    withLock(
      Effect.gen(function* () {
        const settings = yield* store.settings;
        if (settings?.enabled !== 1) return;
        const context = yield* contextOf(settings);
        if (context === null) return;
        const classified = classifyEvent(raw, context, source);
        switch (classified.kind) {
          case "request":
            return yield* file(classified, botToken);
          case "reply":
            return yield* reply(classified, botToken);
          case "reaction": {
            if (classified.reaction !== CHECK_MARK) return;
            if (
              !ownerAccepts({
                ownerUserId: settings.owner_user_id,
                user: classified.user,
                reaction: classified.reaction,
              })
            ) {
              return;
            }
            const request = yield* store.requestAt(classified.channel, classified.ts);
            if (request !== undefined) return yield* accept(request);
            // The owner's ✅ on a reply after the hand-back accepts that adjustment.
            const adjustment = yield* adjustmentAt(classified.channel, classified.ts);
            if (adjustment !== undefined) yield* acceptAdjustment(adjustment);
            return;
          }
          case "ignored":
            return;
        }
      }),
    );

  const interaction: HoustonSlackIntake["Service"]["interaction"] = (payload, botToken) =>
    withLock(
      Effect.gen(function* () {
        if (!isObject(payload)) return;
        const settings = yield* store.settings;
        if (settings?.enabled !== 1) return;
        const owner = settings.owner_user_id;
        const user = str(isObject(payload.user) ? payload.user.id : undefined);
        if (user === undefined) return;
        if (payload.type === "block_actions") {
          const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
          if (!isObject(action)) return;
          const actionId = str(action.action_id) ?? "";
          const channel = str(isObject(payload.channel) ? payload.channel.id : undefined);
          const clickKey = str(action.action_ts) ?? str(payload.trigger_id) ?? "click";
          const isOwner = ownerAccepts({ ownerUserId: owner, user });
          const text = slackText(language(settings));
          if (actionId === OTHER_ANSWER_ACTION || actionId.startsWith(`${ANSWER_ACTION}_`)) {
            const [rawId = "0", rawIndex = ""] = (str(action.value) ?? "").split(":");
            const question = yield* questionOf(Number(rawId));
            if (question === undefined) return;
            const request = yield* store.requestById(question.request_id);
            if (request === undefined) return;
            if (!answerAllowed({ user, requester: request.author, ownerUserId: owner })) {
              return yield* ephemeral(
                request,
                channel ?? request.channel_id,
                user,
                clickKey,
                text.onlyRequesterAnswers(request.author),
              );
            }
            if (actionId !== OTHER_ANSWER_ACTION) {
              const option = optionOf(question.form_json, Number(rawIndex));
              if (option !== undefined) yield* conversation.answer(question.id, user, option);
              return;
            }
            const triggerId = str(payload.trigger_id);
            if (triggerId === undefined) return;
            yield* web
              .call(botToken, "views.open", {
                trigger_id: triggerId,
                view: {
                  type: "modal",
                  callback_id: ANSWER_CALLBACK,
                  private_metadata: String(question.id),
                  title: { type: "plain_text", text: text.otherTitle },
                  submit: { type: "plain_text", text: text.send },
                  close: { type: "plain_text", text: text.cancel },
                  blocks: [
                    {
                      type: "input",
                      block_id: "answer",
                      label: { type: "plain_text", text: text.otherLabel },
                      element: {
                        type: "plain_text_input",
                        action_id: "answer",
                        multiline: true,
                        max_length: HOUSTON_SLACK_LIMITS.dialogChars,
                      },
                    },
                  ],
                },
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Opening the Slack answer dialog failed: ${error.message}`),
                ),
              );
            return;
          }
          if (actionId === ADJUST_ACCEPT_ACTION || actionId === ADJUST_IGNORE_ACTION) {
            const adjustment = yield* adjustmentById(Number(str(action.value) ?? "0"));
            if (adjustment === undefined) return;
            const request = yield* store.requestById(adjustment.request_id);
            if (request === undefined) return;
            if (!isOwner) {
              return yield* ephemeral(request, channel ?? request.channel_id, user, clickKey);
            }
            return yield* actionId === ADJUST_ACCEPT_ACTION
              ? acceptAdjustment(adjustment)
              : ignoreAdjustment(adjustment);
          }
          const request = yield* store.requestById(Number(str(action.value) ?? "0"));
          if (request === undefined) return;
          if (action.action_id === ACCEPT_ACTION) {
            if (isOwner) return yield* accept(request);
            return yield* ephemeral(request, channel ?? request.channel_id, user, clickKey);
          }
          if (action.action_id === REFUSE_ACTION) {
            if (!isOwner) {
              return yield* ephemeral(request, channel ?? request.channel_id, user, clickKey);
            }
            const triggerId = str(payload.trigger_id);
            if (triggerId === undefined) return;
            yield* web
              .call(botToken, "views.open", {
                trigger_id: triggerId,
                view: {
                  type: "modal",
                  callback_id: REFUSE_CALLBACK,
                  private_metadata: String(request.id),
                  title: { type: "plain_text", text: text.refuseTitle },
                  submit: { type: "plain_text", text: text.refuse },
                  close: { type: "plain_text", text: text.cancel },
                  blocks: [
                    {
                      type: "input",
                      block_id: "reason",
                      optional: true,
                      label: { type: "plain_text", text: text.refuseLabel },
                      hint: { type: "plain_text", text: text.refuseHint },
                      element: {
                        type: "plain_text_input",
                        action_id: "reason",
                        multiline: true,
                        max_length: HOUSTON_SLACK_LIMITS.dialogChars,
                      },
                    },
                  ],
                },
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Opening the Slack refusal dialog failed: ${error.message}`),
                ),
              );
          }
          return;
        }
        if (payload.type === "view_submission") {
          const view = isObject(payload.view) ? payload.view : {};
          if (view.callback_id === ANSWER_CALLBACK) {
            const state = isObject(view.state) ? view.state : {};
            const values = isObject(state.values) ? state.values : {};
            const block = isObject(values.answer) ? values.answer : {};
            const input = isObject(block.answer) ? block.answer : {};
            const value = (str(input.value) ?? "").trim();
            if (value.length === 0 || [...value].length > HOUSTON_SLACK_LIMITS.dialogChars) return;
            yield* conversation.answer(Number(str(view.private_metadata) ?? "0"), user, value);
            return;
          }
          if (view.callback_id !== REFUSE_CALLBACK) return;
          if (!ownerAccepts({ ownerUserId: owner, user }) || owner === null) return;
          const request = yield* store.requestById(Number(str(view.private_metadata) ?? "0"));
          if (request === undefined) return;
          const state = isObject(view.state) ? view.state : {};
          const values = isObject(state.values) ? state.values : {};
          const block = isObject(values.reason) ? values.reason : {};
          const input = isObject(block.reason) ? block.reason : {};
          const reason = (str(input.value) ?? "").trim();
          if ([...reason].length > HOUSTON_SLACK_LIMITS.dialogChars) return;
          yield* refuseRequest(request, reason, owner);
        }
      }),
    );

  const acceptAt: HoustonSlackIntake["Service"]["acceptAt"] = (channel, ts) =>
    withLock(
      Effect.gen(function* () {
        const request = yield* store.requestAt(channel, ts);
        if (request !== undefined) yield* accept(request);
      }),
    );

  return HoustonSlackIntake.of({
    event,
    interaction,
    acceptAt,
    withLock,
    startQueued,
    working,
  });
});

export const layer = Layer.effect(HoustonSlackIntake, make);
