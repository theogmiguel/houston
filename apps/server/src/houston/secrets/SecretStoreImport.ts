// The one-time copy of Houston's tokens from the OS keychain into the secret store. A token is
// copied only when the store lacks it; the keychain is only read, so its entries stay. The import
// is recorded once no token is left unread, so a locked or absent keychain is retried next start.
import { HOUSTON_SLACK_LIMITS } from "@houston-app/contracts/houston/slack";
import { HOUSTON_TASK_SOURCE_LIMITS } from "@houston-app/contracts/houston/taskSources";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { APP_TOKEN_ACCOUNT, BOT_TOKEN_ACCOUNT, slackSecretName } from "../slack/rules.ts";
import { trackerSecretName } from "../taskSources/rules.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import { HoustonSecrets } from "./HoustonSecrets.ts";
import { LegacyKeychain, legacyKeychainService } from "./LegacyKeychain.ts";

const LEGACY_TRACKER_ACCOUNT = "integration-token";
const encodeCounts = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ImportCounts {
  readonly copied: number;
  readonly present: number;
  readonly absent: number;
  readonly refused: number;
}

export type ImportResult =
  | { readonly kind: "done" }
  | ({ readonly kind: "imported" } & ImportCounts)
  | ({ readonly kind: "pending"; readonly unread: number } & ImportCounts);

interface Token {
  /** Names the token in a warning; never holds a value. */
  readonly label: string;
  readonly name: string;
  readonly service: string;
  readonly account: string;
  readonly limitBytes: number;
}

const WARNING = "Secret store import";

/** The tokens the database says earlier builds stored: a connected Slack, a tracker per project. */
const recordedTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const slack = yield* sql<{ readonly credential_set_at: string | null }>`
    SELECT credential_set_at FROM houston_slack_settings WHERE id = 1
  `;
  const trackers = yield* sql<{ readonly project_id: string; readonly provider: string }>`
    SELECT project_id, provider FROM houston_task_source_credentials ORDER BY project_id, provider
  `;
  const slackService = legacyKeychainService({
    baseDir: config.baseDir,
    purpose: "slack",
    projectId: "server",
    provider: "connection",
  });
  const tokens: Array<Token> = [];
  if (typeof slack[0]?.credential_set_at === "string") {
    for (const account of [APP_TOKEN_ACCOUNT, BOT_TOKEN_ACCOUNT] as const) {
      tokens.push({
        label: `Slack ${account}`,
        name: slackSecretName(account),
        service: slackService,
        account,
        limitBytes: HOUSTON_SLACK_LIMITS.tokenBytes,
      });
    }
  }
  for (const { project_id: projectId, provider } of trackers) {
    if (provider !== "notion") continue;
    tokens.push({
      label: `${provider} token of project ${projectId}`,
      name: trackerSecretName(projectId, provider),
      service: legacyKeychainService({
        baseDir: config.baseDir,
        purpose: "tracker",
        projectId,
        provider,
      }),
      account: LEGACY_TRACKER_ACCOUNT,
      limitBytes: HOUSTON_TASK_SOURCE_LIMITS.tokenBytes,
    });
  }
  return tokens;
}).pipe(Effect.orDie);

export const importKeychainSecrets: Effect.Effect<
  ImportResult,
  never,
  SqlClient.SqlClient | HoustonSecrets | LegacyKeychain | ServerConfig.ServerConfig
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* HoustonSecrets;
  const keychain = yield* LegacyKeychain;
  const finished = yield* sql`SELECT 1 FROM houston_secret_store_import WHERE id = 1`.pipe(
    Effect.orDie,
  );
  if (finished.length > 0) return { kind: "done" } as const;

  let copied = 0;
  let present = 0;
  let absent = 0;
  let refused = 0;
  let unread = 0;
  const warn = (message: string) => Effect.logWarning(`${WARNING}: ${message}`);

  for (const token of yield* recordedTokens) {
    const stored = yield* Effect.result(secrets.get(token.name));
    if (stored._tag === "Failure") {
      unread += 1;
      yield* warn(`${token.label} could not be checked: ${stored.failure.message}`);
      continue;
    }
    if (Option.isSome(stored.success)) {
      present += 1;
      continue;
    }
    const legacy = yield* Effect.result(keychain.get(token.service, token.account));
    if (legacy._tag === "Failure") {
      unread += 1;
      yield* warn(`${token.label} was not copied: ${legacy.failure.message}`);
      continue;
    }
    if (Option.isNone(legacy.success)) {
      absent += 1;
      continue;
    }
    const size = Buffer.byteLength(Redacted.value(legacy.success.value), "utf8");
    if (size > token.limitBytes) {
      refused += 1;
      yield* warn(
        `${token.label} was not copied: it is ${size} bytes, over the limit of ${token.limitBytes} bytes`,
      );
      continue;
    }
    const written = yield* Effect.result(secrets.set(token.name, legacy.success.value));
    if (written._tag === "Failure") {
      unread += 1;
      yield* warn(`${token.label} was not copied: ${written.failure.message}`);
      continue;
    }
    copied += 1;
  }

  const counts: ImportCounts = { copied, present, absent, refused };
  if (unread > 0) {
    yield* warn(
      `${unread} token(s) are still in the keychain; the import retries at the next start`,
    );
    return { kind: "pending", unread, ...counts } as const;
  }
  const now = yield* nowIso;
  yield* sql`
    INSERT OR IGNORE INTO houston_secret_store_import (id, imported_at, counts_json)
    VALUES (1, ${now}, ${encodeCounts(counts)})
  `.pipe(Effect.orDie);
  return { kind: "imported", ...counts } as const;
});
