// The houston.slack.* operations: both tokens in the OS keychain only and checked with
// auth.test, the settings and channel map checked by rules.ts, the requests and the stream.
import type { ProjectId } from "@t3tools/contracts";
import type {
  HoustonSlackConfigureInput,
  HoustonSlackConnectInput,
  HoustonSlackError,
  HoustonSlackInfo,
  HoustonSlackRequest,
  HoustonSlackRequestsListInput,
  HoustonSlackStreamEvent,
} from "@t3tools/contracts/houston/slack";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonKeychain } from "../secrets/HoustonKeychain.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import { HoustonSlackConnection } from "./Connection.ts";
import {
  APP_TOKEN_ACCOUNT,
  BOT_TOKEN_ACCOUNT,
  checkConfigure,
  checkTokens,
  refuse,
  slackTs,
} from "./rules.ts";
import { HoustonSlackStore } from "./Store.ts";
import { SlackWebApi } from "./WebApi.ts";

export class HoustonSlackService extends Context.Service<
  HoustonSlackService,
  {
    readonly get: Effect.Effect<HoustonSlackInfo, HoustonSlackError>;
    readonly connect: (
      input: HoustonSlackConnectInput,
    ) => Effect.Effect<HoustonSlackInfo, HoustonSlackError>;
    readonly disconnect: Effect.Effect<HoustonSlackInfo, HoustonSlackError>;
    readonly configure: (
      input: HoustonSlackConfigureInput,
    ) => Effect.Effect<HoustonSlackInfo, HoustonSlackError>;
    readonly requests: (
      input: HoustonSlackRequestsListInput,
    ) => Effect.Effect<ReadonlyArray<HoustonSlackRequest>, HoustonSlackError>;
    readonly subscribe: Stream.Stream<HoustonSlackStreamEvent, HoustonSlackError>;
  }
>()("houston/houston/slack/Service/HoustonSlackService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const keychain = yield* HoustonKeychain;
  const web = yield* SlackWebApi;
  const connection = yield* HoustonSlackConnection;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const ensureSettings = Effect.flatMap(nowIso, (now) =>
    run(sql`
      INSERT INTO houston_slack_settings (id, enabled, language, revision, updated_at)
      VALUES (1, 0, 'en', 0, ${now}) ON CONFLICT (id) DO NOTHING
    `),
  );

  const requireProject = (operation: string, projectId: string) =>
    projects.get(projectId as ProjectId).pipe(
      Effect.orDie,
      Effect.flatMap((project) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? Effect.void
          : Effect.fail(refuse("not_found", operation, `no project ${projectId}`)),
      ),
    );

  const keychainRefusal = (operation: string) => (error: { readonly message: string }) =>
    refuse("keychain_unavailable", operation, error.message);

  const removeTokens = (operation: string) =>
    Effect.all([
      keychain.remove(store.tokenService, APP_TOKEN_ACCOUNT),
      keychain.remove(store.tokenService, BOT_TOKEN_ACCOUNT),
    ]).pipe(Effect.asVoid, Effect.mapError(keychainRefusal(operation)));

  const get = store.info(true);

  const enable = (
    extra: { readonly teamId: string; readonly team: string; readonly bot: string } | null,
  ) =>
    Effect.flatMap(nowIso, (now) =>
      store.write(
        Effect.gen(function* () {
          yield* ensureSettings;
          yield* extra === null
            ? run(
                sql`UPDATE houston_slack_settings SET enabled = 1, updated_at = ${now} WHERE id = 1`,
              )
            : run(sql`
                UPDATE houston_slack_settings SET enabled = 1, credential_set_at = ${now},
                  team_id = ${extra.teamId}, team = ${extra.team}, bot_user_id = ${extra.bot},
                  updated_at = ${now}
                WHERE id = 1
              `);
          return { result: undefined, info: true };
        }),
      ),
    );

  const connect: HoustonSlackService["Service"]["connect"] = Effect.fn(
    "HoustonSlackService.connect",
  )(function* (input) {
    const operation = "houston.slack.connect";
    const checked = checkTokens(operation, {
      appToken: input.appToken === undefined ? undefined : Redacted.value(input.appToken),
      botToken: input.botToken === undefined ? undefined : Redacted.value(input.botToken),
    });
    if (checked !== null && !("appToken" in checked)) return yield* checked;
    if (checked === null) {
      const stored = yield* store.readTokens;
      if (stored.kind === "unavailable") {
        return yield* refuse("keychain_unavailable", operation, stored.reason);
      }
      if (stored.kind === "none") {
        return yield* refuse(
          "credential_missing",
          operation,
          "no Slack tokens are stored; connect with the app-level token and the bot token",
        );
      }
      if (stored.kind === "half") return yield* refuse("invalid", operation, stored.message);
      yield* enable(null);
      yield* connection.refresh;
      return yield* get;
    }
    const tokens = {
      [APP_TOKEN_ACCOUNT]: Redacted.make(checked.appToken),
      [BOT_TOKEN_ACCOUNT]: Redacted.make(checked.botToken),
    };
    // Written, then read back; anything short of both stored removes both again.
    const stored = yield* Effect.gen(function* () {
      for (const [account, value] of Object.entries(tokens)) {
        yield* keychain.set(store.tokenService, account, value);
        const back = yield* keychain.get(store.tokenService, account);
        if (Option.isNone(back) || Redacted.value(back.value) !== Redacted.value(value)) {
          return yield* refuse(
            "keychain_unavailable",
            operation,
            `the OS keychain did not return the ${account === APP_TOKEN_ACCOUNT ? "app-level" : "bot"} token it stored`,
          );
        }
      }
    }).pipe(
      Effect.mapError((error) =>
        "kind" in error ? error : refuse("keychain_unavailable", operation, error.message),
      ),
      Effect.result,
    );
    if (stored._tag === "Failure") {
      yield* removeTokens(operation).pipe(Effect.ignore);
      return yield* stored.failure;
    }
    const auth = yield* Effect.result(web.call(tokens[BOT_TOKEN_ACCOUNT], "auth.test", {}));
    const answer = auth._tag === "Success" ? auth.success : null;
    const teamId = typeof answer?.team_id === "string" ? answer.team_id : null;
    const bot = typeof answer?.user_id === "string" ? answer.user_id : null;
    if (auth._tag === "Failure" || teamId === null || bot === null) {
      yield* removeTokens(operation).pipe(Effect.ignore);
      return yield* refuse(
        "remote",
        operation,
        auth._tag === "Failure"
          ? `Slack refused auth.test (${auth.failure.code}): ${auth.failure.message}`
          : `Slack's auth.test answered without ${teamId === null ? "team_id" : "user_id"}`,
      );
    }
    yield* enable({ teamId, team: typeof answer?.team === "string" ? answer.team : teamId, bot });
    yield* connection.refresh;
    return yield* get;
  });

  const disconnect: HoustonSlackService["Service"]["disconnect"] = Effect.gen(function* () {
    const operation = "houston.slack.disconnect";
    yield* removeTokens(operation);
    const now = yield* nowIso;
    yield* store.write(
      Effect.gen(function* () {
        yield* run(sql`
          UPDATE houston_slack_settings SET enabled = 0, credential_set_at = NULL,
            updated_at = ${now} WHERE id = 1
        `);
        return { result: undefined, info: true };
      }),
    );
    yield* connection.refresh;
    yield* store.setStatus({ connection: "off", error: null });
    return yield* get;
  });

  const configure: HoustonSlackService["Service"]["configure"] = Effect.fn(
    "HoustonSlackService.configure",
  )(function* (input) {
    const operation = "houston.slack.configure";
    const refused = checkConfigure(operation, input);
    if (refused !== undefined) return yield* refused;
    for (const { projectId } of input.channels) yield* requireProject(operation, projectId);
    const now = yield* nowIso;
    const cursor = slackTs(Date.parse(now));
    yield* store.write(
      Effect.gen(function* () {
        const settings = yield* store.settings;
        const actual = settings?.revision ?? 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== actual) {
          return yield* refuse(
            "conflict",
            operation,
            `the Slack settings expected revision ${input.expectedRevision}, actual revision ${actual}`,
            { expected: input.expectedRevision, actual },
          );
        }
        yield* ensureSettings;
        if (input.ownerUserId !== undefined) {
          yield* run(sql`
            UPDATE houston_slack_settings SET owner_user_id = ${input.ownerUserId} WHERE id = 1
          `);
        }
        if (input.language !== undefined) {
          yield* run(
            sql`UPDATE houston_slack_settings SET language = ${input.language} WHERE id = 1`,
          );
        }
        yield* run(sql`
          UPDATE houston_slack_settings SET revision = revision + 1, updated_at = ${now} WHERE id = 1
        `);
        const keep = input.channels.map((entry) => entry.channelId);
        yield* run(
          keep.length === 0
            ? sql`DELETE FROM houston_slack_channels`
            : sql`DELETE FROM houston_slack_channels WHERE channel_id NOT IN ${sql.in(keep)}`,
        );
        // A new mapping starts from now; a remapped channel keeps its cursor.
        for (const entry of input.channels) {
          yield* run(sql`
            INSERT INTO houston_slack_channels (channel_id, project_id, cursor_ts, mapped_at)
            VALUES (${entry.channelId}, ${entry.projectId}, ${cursor}, ${now})
            ON CONFLICT (channel_id) DO UPDATE SET project_id = excluded.project_id
          `);
        }
        return { result: undefined, info: true };
      }),
    );
    return yield* get;
  });

  const requests: HoustonSlackService["Service"]["requests"] = Effect.fn(
    "HoustonSlackService.requests",
  )(function* (input) {
    if (input.projectId !== undefined) {
      yield* requireProject("houston.slack.requests.list", input.projectId);
    }
    return yield* store.requests(input.projectId);
  });

  const subscribe: HoustonSlackService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing before the read keeps every event committed during it.
      const subscription = yield* PubSub.subscribe(store.events);
      const info = yield* store.info(true);
      const all = yield* store.requests();
      return Stream.concat(
        Stream.succeed<HoustonSlackStreamEvent>({ snapshot: { info, requests: all } }),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  return HoustonSlackService.of({ get, connect, disconnect, configure, requests, subscribe });
});

export const layer = Layer.effect(HoustonSlackService, make);
