// The Slack intake's tables, its connection status and its stream. Every write runs inside the
// Tasks store's transaction, so a request and its task land together; events follow commit order.
import type { ProjectId } from "@t3tools/contracts";
import type {
  HoustonSlackConnection,
  HoustonSlackInfo,
  HoustonSlackLanguage,
  HoustonSlackRequest,
  HoustonSlackRequestState,
  HoustonSlackStreamEvent,
} from "@t3tools/contracts/houston/slack";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonKeychain } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskStore, nowIso } from "../tasks/TaskStore.ts";
import {
  APP_TOKEN_ACCOUNT,
  BOT_TOKEN_ACCOUNT,
  reactionMove,
  slackKeychainService,
  type StatusReaction,
} from "./rules.ts";

export const KEYCHAIN_UNAVAILABLE = "Slack tokens are not available from the OS keychain";

const encodeBlocks = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface SettingsRow {
  readonly enabled: number;
  readonly owner_user_id: string | null;
  readonly language: HoustonSlackLanguage;
  readonly credential_set_at: string | null;
  readonly team_id: string | null;
  readonly team: string | null;
  readonly bot_user_id: string | null;
  readonly revision: number;
}

export interface ChannelRow {
  readonly channel_id: string;
  readonly project_id: string;
  readonly cursor_ts: string;
}

export interface RequestRow {
  readonly id: number;
  readonly channel_id: string;
  readonly ts: string;
  readonly author: string;
  readonly project_id: string;
  readonly task_id: number | null;
  readonly state: HoustonSlackRequestState;
  readonly status_reaction: StatusReaction | null;
  readonly permalink: string | null;
  readonly queued_at: string | null;
  readonly created_at: string;
  readonly awaiting_reply: number;
  readonly attachments_json: string | null;
}

export interface OutboxEntry {
  readonly requestId: number;
  readonly dedupeKey: string;
  readonly target: "thread" | "dm" | "update" | "react" | "ephemeral";
  readonly text: string;
  readonly blocks?: ReadonlyArray<unknown>;
  readonly reaction?: string;
  readonly removeReaction?: string | null;
  readonly messageTs?: string;
  /** For `update`: the dedupe key of the message it edits. */
  readonly updateOf?: string;
  /** For `dm` and `ephemeral`: the member. */
  readonly userId?: string;
  /** For `ephemeral`: the channel it is shown in. */
  readonly channel?: string;
}

export interface SlackStatus {
  readonly connection: HoustonSlackConnection;
  readonly lastEventAt: string | null;
  readonly lastCatchupAt: string | null;
  readonly error: string | null;
}

export type TokenRead =
  | {
      readonly kind: "ok";
      readonly appToken: Redacted.Redacted<string>;
      readonly botToken: Redacted.Redacted<string>;
    }
  | { readonly kind: "none" }
  | { readonly kind: "half"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface SlackWrite<A> {
  readonly result: A;
  /** Task ids the Tasks stream publishes. */
  readonly touched?: ReadonlyArray<number>;
  /** Request ids whose new state is published. */
  readonly requests?: ReadonlyArray<number>;
  /** Whether the settings changed. */
  readonly info?: boolean;
}

export class HoustonSlackStore extends Context.Service<
  HoustonSlackStore,
  {
    /** Runs `body` in the Tasks store's transaction, then publishes what it changed. */
    readonly write: <A, E, R>(body: Effect.Effect<SlackWrite<A>, E, R>) => Effect.Effect<A, E, R>;
    readonly events: PubSub.PubSub<HoustonSlackStreamEvent>;
    readonly settings: Effect.Effect<SettingsRow | undefined>;
    readonly channels: Effect.Effect<ReadonlyArray<ChannelRow>>;
    readonly tokenService: string;
    /** Both tokens, read from the OS keychain now. */
    readonly readTokens: Effect.Effect<TokenRead>;
    /** The bot token alone; null when absent or unreadable. */
    readonly readBotToken: Effect.Effect<Redacted.Redacted<string> | null>;
    /** The info; `fresh` reads the keychain, otherwise the last read is reported. */
    readonly info: (fresh: boolean) => Effect.Effect<HoustonSlackInfo>;
    readonly setStatus: (patch: Partial<SlackStatus>) => Effect.Effect<void>;
    readonly requestById: (id: number) => Effect.Effect<RequestRow | undefined>;
    readonly requestAt: (channel: string, ts: string) => Effect.Effect<RequestRow | undefined>;
    readonly requests: (projectId?: string) => Effect.Effect<ReadonlyArray<HoustonSlackRequest>>;
    /** Queues a row for Slack; an existing dedupe key adds nothing. Runs in the caller's write. */
    readonly enqueue: (entry: OutboxEntry) => Effect.Effect<void>;
    /** Moves the request's one status reaction to `next`. Runs in the caller's write. */
    readonly react: (requestId: number, next: StatusReaction) => Effect.Effect<void>;
    /** The next free dedupe key under `prefix`, for rows a request may owe more than once. */
    readonly nextKey: (prefix: string) => Effect.Effect<string>;
    /** Unmaps a deleted project's channels; its requests stay. */
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("houston/houston/slack/Store/HoustonSlackStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* HoustonTaskStore;
  const keychain = yield* HoustonKeychain;
  const config = yield* ServerConfig.ServerConfig;
  const events = yield* PubSub.unbounded<HoustonSlackStreamEvent>();
  const lock = yield* Semaphore.make(1);
  const status = yield* Ref.make<SlackStatus>({
    connection: "off",
    lastEventAt: null,
    lastCatchupAt: null,
    error: null,
  });
  // The last keychain read, so a published info event does not read the keychain again.
  const tokensSeen = yield* Ref.make<TokenRead>({ kind: "none" });
  const tokenService = slackKeychainService(config.baseDir);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const settings = run(sql<SettingsRow>`SELECT * FROM houston_slack_settings WHERE id = 1`).pipe(
    Effect.map((rows) => rows[0]),
  );
  const channels = run(sql<ChannelRow>`
    SELECT channel_id, project_id, cursor_ts FROM houston_slack_channels ORDER BY channel_id
  `);

  const readTokens = Effect.gen(function* () {
    const read = yield* Effect.result(
      Effect.all([
        keychain.get(tokenService, APP_TOKEN_ACCOUNT),
        keychain.get(tokenService, BOT_TOKEN_ACCOUNT),
      ]),
    );
    const result: TokenRead =
      read._tag === "Failure"
        ? { kind: "unavailable", reason: read.failure.message }
        : Option.isSome(read.success[0]) && Option.isSome(read.success[1])
          ? { kind: "ok", appToken: read.success[0].value, botToken: read.success[1].value }
          : Option.isSome(read.success[0])
            ? {
                kind: "half",
                message:
                  "the Slack bot token (xoxb-) is missing from the OS keychain; connect again with both",
              }
            : Option.isSome(read.success[1])
              ? {
                  kind: "half",
                  message:
                    "the Slack app-level token (xapp-) is missing from the OS keychain; connect again with both",
                }
              : { kind: "none" };
    yield* Ref.set(tokensSeen, result);
    return result;
  });

  const readBotToken = keychain.get(tokenService, BOT_TOKEN_ACCOUNT).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );

  const info = Effect.fn("HoustonSlackStore.info")(function* (fresh: boolean) {
    const row = yield* settings;
    const mapped = yield* channels;
    const current = yield* Ref.get(status);
    const tokens = fresh ? yield* readTokens : yield* Ref.get(tokensSeen);
    return {
      enabled: row?.enabled === 1,
      hasTokens: tokens.kind === "ok",
      connection: current.connection,
      team: row?.team ?? null,
      botUserId: row?.bot_user_id ?? null,
      ownerUserId: row?.owner_user_id ?? null,
      channels: mapped.map((channel) => ({
        channelId: channel.channel_id,
        projectId: channel.project_id as ProjectId,
      })),
      language: row?.language ?? "en",
      lastEventAt: current.lastEventAt,
      lastCatchupAt: current.lastCatchupAt,
      error: tokens.kind === "half" ? tokens.message : current.error,
      revision: row?.revision ?? 0,
    } satisfies HoustonSlackInfo;
  });

  const setStatus = Effect.fn("HoustonSlackStore.setStatus")(function* (
    patch: Partial<SlackStatus>,
  ) {
    const before = yield* Ref.get(status);
    const after = { ...before, ...patch };
    const keys = ["connection", "lastEventAt", "lastCatchupAt", "error"] as const;
    if (keys.every((key) => after[key] === before[key])) return;
    yield* Ref.set(status, after);
    // Each change is its own event; lastEventAt alone changes too often to publish.
    if (Object.keys(patch).every((key) => key === "lastEventAt")) return;
    yield* PubSub.publish(events, { info: yield* info(false) });
  });

  const queuePosition = (row: RequestRow) =>
    row.state !== "queued"
      ? Effect.succeedNone
      : run(sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM houston_slack_requests
          WHERE state = 'queued'
            AND (queued_at < ${row.queued_at} OR (queued_at = ${row.queued_at} AND id <= ${row.id}))
        `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.n)));

  const toRequest = (row: RequestRow) =>
    Effect.map(queuePosition(row), (position): HoustonSlackRequest => ({
      taskId: row.task_id,
      projectId: row.project_id as ProjectId,
      author: row.author,
      channelId: row.channel_id,
      state: row.state,
      ...(Option.isSome(position) ? { queuePosition: position.value } : {}),
      permalink: row.permalink,
      statusReaction: row.status_reaction,
    }));

  const requestById = (id: number) =>
    run(sql<RequestRow>`SELECT * FROM houston_slack_requests WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const requestAt = (channel: string, ts: string) =>
    run(sql<RequestRow>`
      SELECT * FROM houston_slack_requests WHERE channel_id = ${channel} AND ts = ${ts}
    `).pipe(Effect.map((rows) => rows[0]));

  const requests = (projectId?: string) =>
    run(
      projectId === undefined
        ? sql<RequestRow>`SELECT * FROM houston_slack_requests ORDER BY id`
        : sql<RequestRow>`
            SELECT * FROM houston_slack_requests WHERE project_id = ${projectId} ORDER BY id
          `,
    ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, toRequest)));

  const write: HoustonSlackStore["Service"]["write"] = (body) =>
    lock.withPermits(1)(
      tasks
        .write(
          body.pipe(Effect.map((outcome) => ({ result: outcome, touched: outcome.touched ?? [] }))),
        )
        .pipe(
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              for (const id of new Set(outcome.requests ?? [])) {
                const row = yield* requestById(id);
                if (row !== undefined) {
                  yield* PubSub.publish(events, { request: yield* toRequest(row) });
                }
              }
              if (outcome.info === true) {
                yield* PubSub.publish(events, { info: yield* info(false) });
              }
            }),
          ),
          Effect.map((outcome) => outcome.result),
        ),
    );

  const enqueue = (entry: OutboxEntry) =>
    Effect.flatMap(nowIso, (now) =>
      run(sql`
      INSERT INTO houston_slack_outbox (
        request_id, dedupe_key, target, text, blocks_json, reaction, remove_reaction, message_ts,
        update_of, user_id, posted_channel, created_at
      ) VALUES (
        ${entry.requestId}, ${entry.dedupeKey}, ${entry.target}, ${entry.text},
        ${entry.blocks === undefined ? null : encodeBlocks(entry.blocks)},
        ${entry.reaction ?? null}, ${entry.removeReaction ?? null}, ${entry.messageTs ?? null},
        ${entry.updateOf ?? null}, ${entry.userId ?? null}, ${entry.channel ?? null},
        ${now}
      ) ON CONFLICT (dedupe_key) DO NOTHING
    `),
    ).pipe(Effect.asVoid);

  const nextKey = (prefix: string) =>
    run(sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM houston_slack_outbox WHERE dedupe_key LIKE ${`${prefix}:%`}
    `).pipe(Effect.map((rows) => `${prefix}:${(rows[0]?.n ?? 0) + 1}`));

  const react = Effect.fn("HoustonSlackStore.react")(function* (
    requestId: number,
    next: StatusReaction,
  ) {
    const row = yield* requestById(requestId);
    if (row === undefined) return;
    const move = reactionMove(row.status_reaction, next);
    if (move === null) return;
    yield* enqueue({
      requestId,
      dedupeKey: yield* nextKey(`react:${requestId}`),
      target: "react",
      text: "",
      reaction: move.add,
      removeReaction: move.remove,
      messageTs: row.ts,
    });
    yield* run(sql`
      UPDATE houston_slack_requests SET status_reaction = ${next} WHERE id = ${requestId}
    `);
  });

  const projectRemoved = (projectId: ProjectId) =>
    write(
      run(sql`DELETE FROM houston_slack_channels WHERE project_id = ${projectId}`).pipe(
        Effect.as({ result: undefined, info: true }),
      ),
    );

  return HoustonSlackStore.of({
    write,
    events,
    settings,
    channels,
    tokenService,
    readTokens,
    readBotToken,
    info,
    setStatus,
    requestById,
    requestAt,
    requests,
    enqueue,
    react,
    nextKey,
    projectRemoved,
  });
});

export const layer = Layer.effect(HoustonSlackStore, make);

/** At startup, unmaps the channels of projects deleted while the deletion hook could not run. */
export const sweep = Effect.gen(function* () {
  const store = yield* HoustonSlackStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const live = new Set(
    (yield* projects.list())
      .filter((project) => project.deletedAt === null)
      .map((project) => project.projectId as string),
  );
  for (const channel of yield* store.channels) {
    if (!live.has(channel.project_id)) yield* store.projectRemoved(channel.project_id as ProjectId);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to unmap the Slack channels of deleted projects.", cause),
  ),
);
