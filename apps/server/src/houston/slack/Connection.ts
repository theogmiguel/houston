// The Socket Mode connection: while enabled with both tokens, one WebSocket from
// apps.connections.open (wss only), an ack before each envelope is handled, pings, silence and
// blocked-write detection, backoff, and a catch-up of each mapped channel after every hello.
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { nowIso } from "../tasks/TaskStore.ts";
import { HoustonSlackIntake } from "./Intake.ts";
import {
  catchupOldest,
  checkSocketUrl,
  compareTs,
  historyActions,
  slackTs,
  type SlackContext,
} from "./rules.ts";
import { HoustonSlackStore, KEYCHAIN_UNAVAILABLE } from "./Store.ts";
import { SlackWebApi } from "./WebApi.ts";

// Slack's own timings for Socket Mode clients, as Houston 1 used them.
const PING_EVERY = Duration.seconds(30);
const SILENT_AFTER_MS = 90_000;
const WRITE_TIMEOUT = Duration.seconds(20);
const OPEN_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_SECONDS = 60;
const HISTORY_PAGE = 200;
const LINK_DISABLED = "Socket Mode was turned off for the app";

export type SocketIncoming =
  | { readonly type: "frame"; readonly text: string }
  | { readonly type: "pong" }
  | { readonly type: "closed" };

export interface SlackSocketSession {
  readonly incoming: Queue.Dequeue<SocketIncoming>;
  readonly send: (text: string) => Effect.Effect<void, string>;
  readonly ping: Effect.Effect<void>;
}

/** Opens a WebSocket; the live one is the `ws` package, which exposes pings and pongs. */
export class SlackSocketTransport extends Context.Service<
  SlackSocketTransport,
  { readonly open: (url: string) => Effect.Effect<SlackSocketSession, string, Scope.Scope> }
>()("houston/houston/slack/Connection/SlackSocketTransport") {}

const openSocket = Effect.fn("HoustonSlack.openSocket")(function* (url: string) {
  const incoming = yield* Queue.unbounded<SocketIncoming>();
  const ws = yield* Effect.acquireRelease(
    Effect.callback<InstanceType<typeof NodeWS.WebSocket>, string>((resume) => {
      const socket = new NodeWS.WebSocket(url, { handshakeTimeout: OPEN_TIMEOUT_MS });
      // An error nobody listens to would exit the server.
      socket.on("error", () => undefined);
      socket.once("open", () => resume(Effect.succeed(socket)));
      socket.once("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            `the Socket Mode connection could not open: ${error.code ?? error.name ?? "error"}`,
          ),
        ),
      );
      return Effect.sync(() => socket.terminate());
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  ws.on("message", (data: unknown) => {
    Queue.offerUnsafe(incoming, { type: "frame", text: String(data) });
  });
  ws.on("pong", () => {
    Queue.offerUnsafe(incoming, { type: "pong" });
  });
  ws.on("close", () => {
    Queue.offerUnsafe(incoming, { type: "closed" });
  });
  return {
    incoming,
    send: (text: string) =>
      Effect.callback<void, string>((resume) => {
        ws.send(text, (error) =>
          resume(
            error === undefined || error === null
              ? Effect.void
              : Effect.fail("the socket write failed"),
          ),
        );
      }),
    ping: Effect.sync(() => {
      try {
        ws.ping();
      } catch {
        // A closing socket refuses the ping; the close arrives as its own event.
      }
    }),
  } satisfies SlackSocketSession;
});

export const layerSocketTransport = Layer.succeed(
  SlackSocketTransport,
  SlackSocketTransport.of({ open: openSocket }),
);

export class HoustonSlackConnection extends Context.Service<
  HoustonSlackConnection,
  {
    /** Ends the current connection and starts again from the stored settings and tokens. */
    readonly refresh: Effect.Effect<void>;
  }
>()("houston/houston/slack/Connection/HoustonSlackConnection") {}

type SessionEnd = "silent" | "closed" | "blocked" | "disconnect" | "link_disabled" | "open_failed";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeFrame = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const parse = (text: string): unknown => Option.getOrUndefined(decodeFrame(text));

const encodeAck = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.String })),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const web = yield* SlackWebApi;
  const transport = yield* SlackSocketTransport;
  const intake = yield* HoustonSlackIntake;
  const layerScope = yield* Effect.scope;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  // Envelopes are acked, then handled here one at a time, so a slow request never delays an ack.
  const inbox = yield* Queue.unbounded<{
    readonly envelope: Readonly<Record<string, unknown>>;
    readonly botToken: Redacted.Redacted<string>;
  }>();
  yield* Effect.gen(function* () {
    for (;;) {
      const { envelope, botToken } = yield* Queue.take(inbox);
      const payload = isObject(envelope.payload) ? envelope.payload : {};
      yield* (
        envelope.type === "events_api"
          ? intake.event(payload.event, botToken, "live")
          : envelope.type === "interactive"
            ? intake.interaction(payload, botToken)
            : Effect.void
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("A Slack event failed.", cause)));
    }
  }).pipe(Effect.forkIn(layerScope));

  const catchUp = Effect.fn("HoustonSlackConnection.catchUp")(function* (
    botToken: Redacted.Redacted<string>,
  ) {
    const settings = yield* store.settings;
    if (settings?.bot_user_id == null || settings.team_id === null) return;
    const channels = yield* store.channels;
    const context: SlackContext = {
      botUserId: settings.bot_user_id,
      teamId: settings.team_id,
      channels: new Set(channels.map((channel) => channel.channel_id)),
    };
    for (const channel of channels) {
      const oldest = catchupOldest(channel.cursor_ts, yield* Clock.currentTimeMillis);
      const messages: Array<unknown> = [];
      let cursor: string | undefined;
      for (;;) {
        const page = yield* web.call(botToken, "conversations.history", {
          channel: channel.channel_id,
          oldest,
          limit: HISTORY_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (Array.isArray(page.messages)) messages.push(...page.messages);
        const metadata = isObject(page.response_metadata) ? page.response_metadata : {};
        const next = typeof metadata.next_cursor === "string" ? metadata.next_cursor : "";
        if (page.has_more !== true || next.length === 0) break;
        cursor = next;
      }
      const fresh = messages.filter(
        (message) =>
          isObject(message) && typeof message.ts === "string" && compareTs(message.ts, oldest) > 0,
      ) as ReadonlyArray<Readonly<Record<string, unknown>>>;
      const filed = new Set(
        (yield* run(sql<{ readonly ts: string }>`
          SELECT ts FROM houston_slack_requests WHERE channel_id = ${channel.channel_id}
        `)).map((row) => row.ts),
      );
      const actions = historyActions(fresh, channel.channel_id, {
        ...context,
        ownerUserId: settings.owner_user_id,
        filed,
      });
      const byTs = new Map(fresh.map((message) => [message.ts as string, message]));
      for (const action of actions) {
        if (action.kind === "file") {
          yield* intake.event(
            { ...byTs.get(action.request.ts), channel: channel.channel_id },
            botToken,
            "history",
          );
        } else {
          yield* intake.acceptAt(channel.channel_id, action.ts);
        }
      }
      const newest = fresh
        .map((message) => message.ts as string)
        .reduce<string | null>(
          (max, ts) => (max === null || compareTs(ts, max) > 0 ? ts : max),
          null,
        );
      if (newest !== null && compareTs(newest, channel.cursor_ts) > 0) {
        yield* store.write(
          run(sql`
            UPDATE houston_slack_channels SET cursor_ts = ${newest}
            WHERE channel_id = ${channel.channel_id}
          `).pipe(Effect.as({ result: undefined })),
        );
      }
    }
    // Replies in the threads of open requests, as if they had arrived live.
    const open = yield* run(sql<{ readonly channel_id: string; readonly ts: string }>`
      SELECT channel_id, ts FROM houston_slack_requests
      WHERE state IN ('pending', 'queued', 'started') OR awaiting_reply = 1
      ORDER BY id
    `);
    const windowStart = slackTs((yield* Clock.currentTimeMillis) - 24 * 3_600_000);
    for (const request of open) {
      if (!context.channels.has(request.channel_id)) continue;
      const answer = yield* web.call(botToken, "conversations.replies", {
        channel: request.channel_id,
        ts: request.ts,
        oldest: compareTs(request.ts, windowStart) > 0 ? request.ts : windowStart,
        limit: HISTORY_PAGE,
      });
      const replies = Array.isArray(answer.messages) ? answer.messages.filter(isObject) : [];
      for (const message of replies.toSorted((left, right) =>
        compareTs(String(left.ts ?? "0"), String(right.ts ?? "0")),
      )) {
        if (message.ts === request.ts) continue;
        yield* intake.event({ ...message, channel: request.channel_id }, botToken, "history");
      }
    }
    yield* store.setStatus({ lastCatchupAt: yield* nowIso });
  });

  /** One socket from open to its end. */
  const session = (url: string, botToken: Redacted.Redacted<string>, hello: Ref.Ref<boolean>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.result(transport.open(url));
        if (opened._tag === "Failure") {
          yield* Effect.logWarning(`Slack Socket Mode: ${opened.failure}`);
          return "open_failed" as SessionEnd;
        }
        const socket = opened.success;
        let lastReceived = yield* Clock.currentTimeMillis;
        yield* Effect.forkScoped(
          Effect.forever(Effect.sleep(PING_EVERY).pipe(Effect.andThen(socket.ping))),
        );
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          const remaining = lastReceived + SILENT_AFTER_MS - now;
          if (remaining <= 0) return "silent" as SessionEnd;
          const next = yield* Queue.take(socket.incoming).pipe(
            Effect.timeoutOption(Duration.millis(remaining)),
          );
          if (Option.isNone(next)) continue;
          lastReceived = yield* Clock.currentTimeMillis;
          const incoming = next.value;
          if (incoming.type === "pong") continue;
          if (incoming.type === "closed") return "closed" as SessionEnd;
          const frame = parse(incoming.text);
          if (!isObject(frame)) continue;
          if (frame.type === "hello") {
            yield* Ref.set(hello, true);
            yield* store.setStatus({ connection: "connected", error: null });
            yield* Effect.forkScoped(
              catchUp(botToken).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("The Slack catch-up failed.", cause),
                ),
              ),
            );
            continue;
          }
          if (frame.type === "disconnect") {
            return (
              frame.reason === "link_disabled" ? "link_disabled" : "disconnect"
            ) as SessionEnd;
          }
          if (typeof frame.envelope_id === "string") {
            const acked = yield* socket
              .send(encodeAck({ envelope_id: frame.envelope_id }))
              .pipe(Effect.timeoutOption(WRITE_TIMEOUT), Effect.result);
            if (acked._tag === "Failure") return "closed" as SessionEnd;
            if (Option.isNone(acked.success)) return "blocked" as SessionEnd;
            yield* store.setStatus({ lastEventAt: yield* nowIso });
            yield* Queue.offer(inbox, { envelope: frame, botToken });
          }
        }
      }),
    );

  const backoff = (failures: number) =>
    Duration.seconds(Math.min(MAX_BACKOFF_SECONDS, 2 ** failures));

  const loop = Effect.gen(function* () {
    let failures = 0;
    for (;;) {
      const settings = yield* store.settings;
      if (settings?.enabled !== 1) {
        yield* store.setStatus({ connection: "off", error: null });
        return yield* Effect.never;
      }
      const tokens = yield* store.readTokens;
      if (tokens.kind === "unavailable") {
        yield* Effect.logWarning(`Slack: the OS keychain could not be read: ${tokens.reason}`);
        yield* store.setStatus({ connection: "retrying", error: KEYCHAIN_UNAVAILABLE });
        yield* Effect.sleep(backoff(failures));
        failures += 1;
        continue;
      }
      if (tokens.kind !== "ok") {
        yield* store.setStatus({
          connection: "retrying",
          error:
            tokens.kind === "half"
              ? tokens.message
              : "no Slack tokens are stored; connect with both tokens",
        });
        return yield* Effect.never;
      }
      yield* store.setStatus({ connection: "connecting" });
      const opened = yield* Effect.result(web.call(tokens.appToken, "apps.connections.open", {}));
      const url =
        opened._tag === "Success" && typeof opened.success.url === "string"
          ? opened.success.url
          : null;
      const refusal =
        opened._tag === "Failure"
          ? opened.failure.message
          : url === null
            ? "Slack's apps.connections.open answered without a URL"
            : checkSocketUrl(url, web.allowLoopback);
      if (refusal !== null || url === null) {
        yield* Effect.logWarning(`Slack Socket Mode could not connect: ${refusal}`);
        yield* store.setStatus({ connection: "retrying", error: refusal });
        yield* Effect.sleep(backoff(failures));
        failures += 1;
        continue;
      }
      const hello = yield* Ref.make(false);
      const end = yield* session(url, tokens.botToken, hello);
      if (yield* Ref.get(hello)) failures = 0;
      yield* Effect.logInfo(`Slack Socket Mode connection ended: ${end}`);
      if (end === "link_disabled") {
        yield* store.setStatus({ connection: "retrying", error: LINK_DISABLED });
        yield* Effect.sleep(Duration.seconds(MAX_BACKOFF_SECONDS));
        continue;
      }
      yield* store.setStatus({ connection: "retrying" });
      yield* Effect.sleep(backoff(failures));
      failures += 1;
    }
  });

  const current = yield* Ref.make<Fiber.Fiber<void> | null>(null);
  const refreshLock = yield* Semaphore.make(1);
  const refresh = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const previous = yield* Ref.get(current);
      if (previous !== null) yield* Fiber.interrupt(previous);
      const fiber = yield* loop.pipe(
        Effect.catchCause((cause) => Effect.logWarning("The Slack connection stopped.", cause)),
        Effect.forkIn(layerScope),
      );
      yield* Ref.set(current, fiber);
    }),
  );
  yield* refresh;

  return HoustonSlackConnection.of({ refresh });
});

export const layer = Layer.effect(HoustonSlackConnection, make);
