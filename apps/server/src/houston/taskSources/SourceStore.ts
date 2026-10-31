// The task source tables. Every write runs inside the Tasks store's transaction, so a record's
// task, initiative and link land together; source events are published in commit order.
import type { ProjectId } from "@t3tools/contracts";
import {
  HoustonTaskSourceSnapshot,
  HoustonTaskSourceSyncState,
  type HoustonTaskSourceLink,
  type HoustonTaskSourceProvider,
  type HoustonTaskSourceSettings,
  type HoustonTaskSourceStreamEvent,
} from "@t3tools/contracts/houston/taskSources";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonKeychain, keychainService } from "../secrets/HoustonKeychain.ts";
import { HoustonTaskStore } from "../tasks/TaskStore.ts";
import { TOKEN_ACCOUNT, storedSettings, unsetSettings, type StoredSettings } from "./rules.ts";

export const StoredSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    githubRepository: Schema.NullOr(Schema.String),
    githubLabel: Schema.NullOr(Schema.String),
    githubAssignedUser: Schema.NullOr(Schema.String),
    notionDataSourceId: Schema.NullOr(Schema.String),
    notionTitlePropertyId: Schema.NullOr(Schema.String),
    notionDescriptionPropertyId: Schema.NullOr(Schema.String),
    notionStatusPropertyId: Schema.NullOr(Schema.String),
    notionAssigneePropertyId: Schema.NullOr(Schema.String),
    notionProjectRelationPropertyId: Schema.NullOr(Schema.String),
    notionAssigneeUserId: Schema.NullOr(Schema.String),
    notionActiveStatusValues: Schema.Array(Schema.String),
    notionProjectsDataSourceId: Schema.NullOr(Schema.String),
    notionProjectTitlePropertyId: Schema.NullOr(Schema.String),
    notionProjectDescriptionPropertyId: Schema.NullOr(Schema.String),
    notionPrUrlPropertyId: Schema.NullOr(Schema.String),
    notionStatusMapping: Schema.Struct({
      todo: Schema.NullOr(Schema.String),
      inProgress: Schema.NullOr(Schema.String),
      inReview: Schema.NullOr(Schema.String),
      done: Schema.NullOr(Schema.String),
      canceled: Schema.NullOr(Schema.String),
    }),
  }),
);
const decodeSettings = Schema.decodeUnknownSync(StoredSettingsJson);
const encodeStored = Schema.encodeSync(StoredSettingsJson);
export const encodeSettings = (settings: StoredSettings) => {
  const { enabled: _enabled, ...rest } = settings;
  return encodeStored(rest);
};
export const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(HoustonTaskSourceSnapshot));
export const decodeSnapshot = Schema.decodeUnknownSync(
  Schema.fromJsonString(HoustonTaskSourceSnapshot),
);
export const encodeSyncState = Schema.encodeSync(Schema.fromJsonString(HoustonTaskSourceSyncState));
const decodeSyncState = Schema.decodeUnknownSync(Schema.fromJsonString(HoustonTaskSourceSyncState));

export interface SettingsRow {
  readonly project_id: string;
  readonly provider: HoustonTaskSourceProvider;
  readonly enabled: number;
  readonly settings_json: string;
  readonly revision: number;
}

export interface PollRow {
  readonly cursor_json: string;
  readonly last_sync_at: string | null;
  readonly last_error: string | null;
  readonly refresh_after: string | null;
}

export interface LinkRow {
  readonly task_id: number;
  readonly project_id: string;
  readonly provider: HoustonTaskSourceProvider;
  readonly external_id: string;
  readonly source: "source" | "pull_request";
  readonly url: string;
  readonly remote_rev: string | null;
  readonly body_hash: string | null;
  readonly fetched_at: string | null;
  readonly synced_at: string | null;
  readonly snapshot_json: string;
  readonly sync_state_json: string;
}

export const toLink = (row: LinkRow): HoustonTaskSourceLink => ({
  taskId: row.task_id,
  projectId: row.project_id as ProjectId,
  provider: row.provider,
  externalId: row.external_id,
  url: row.url,
  source: row.source,
  remoteRev: row.remote_rev,
  bodyHash: row.body_hash,
  fetchedAt: row.fetched_at,
  syncedAt: row.synced_at,
  snapshot: decodeSnapshot(row.snapshot_json),
  syncState: decodeSyncState(row.sync_state_json),
});

export const settingsFromRow = (row: SettingsRow): StoredSettings => ({
  ...storedSettings({ enabled: false }),
  ...decodeSettings(row.settings_json),
  enabled: row.enabled !== 0,
});

export interface SourceEvent {
  readonly projectId: string;
  readonly event: HoustonTaskSourceStreamEvent;
}

export interface SourceWrite<A> {
  readonly result: A;
  readonly touched: ReadonlyArray<number>;
  readonly events: ReadonlyArray<SourceEvent>;
}

export class HoustonTaskSourceStore extends Context.Service<
  HoustonTaskSourceStore,
  {
    /** Runs `body` in the Tasks store's transaction, then publishes its events in order. */
    readonly write: <A, E, R>(body: Effect.Effect<SourceWrite<A>, E, R>) => Effect.Effect<A, E, R>;
    readonly events: PubSub.PubSub<SourceEvent>;
    readonly settingsRow: (
      projectId: string,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<SettingsRow | undefined>;
    readonly enabledRows: Effect.Effect<ReadonlyArray<SettingsRow>>;
    readonly pollRow: (
      projectId: string,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<PollRow | undefined>;
    readonly linksOf: (taskId: number) => Effect.Effect<ReadonlyArray<HoustonTaskSourceLink>>;
    /** The OS keychain service of a project's tracker token. */
    readonly tokenService: (projectId: string, provider: HoustonTaskSourceProvider) => string;
    /** Whether the keychain holds the token; false when it cannot be read. */
    readonly hasCredential: (
      projectId: string,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<boolean>;
    /** Both providers' settings for a project, unset ones included. */
    readonly settingsOf: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<HoustonTaskSourceSettings>>;
    /** Drops the record of a keychain entry once the entry is removed. */
    readonly forgetCredential: (
      projectId: string,
      provider: HoustonTaskSourceProvider,
    ) => Effect.Effect<void>;
    /** Removes a deleted project's settings, poll state and tokens; its tasks keep their links. */
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("houston/houston/taskSources/SourceStore/HoustonTaskSourceStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* HoustonTaskStore;
  const keychain = yield* HoustonKeychain;
  const config = yield* ServerConfig.ServerConfig;
  const events = yield* PubSub.unbounded<SourceEvent>();
  const lock = yield* Semaphore.make(1);

  const write: HoustonTaskSourceStore["Service"]["write"] = (body) =>
    lock.withPermits(1)(
      tasks
        .write(body.pipe(Effect.map((outcome) => ({ result: outcome, touched: outcome.touched }))))
        .pipe(
          Effect.tap((outcome) => PubSub.publishAll(events, outcome.events)),
          Effect.map((outcome) => outcome.result),
        ),
    );

  const settingsRow = (projectId: string, provider: HoustonTaskSourceProvider) =>
    sql<SettingsRow>`
      SELECT * FROM houston_task_source_settings
      WHERE project_id = ${projectId} AND provider = ${provider}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const pollRow = (projectId: string, provider: HoustonTaskSourceProvider) =>
    sql<PollRow>`
      SELECT cursor_json, last_sync_at, last_error, refresh_after FROM houston_task_source_poll
      WHERE project_id = ${projectId} AND provider = ${provider}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );

  const tokenService = (projectId: string, provider: HoustonTaskSourceProvider) =>
    keychainService({ baseDir: config.baseDir, purpose: "tracker", projectId, provider });

  const hasCredential = (projectId: string, provider: HoustonTaskSourceProvider) =>
    provider === "github_issues"
      ? Effect.succeed(false)
      : keychain.get(tokenService(projectId, provider), TOKEN_ACCOUNT).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        );

  const settingsOf = Effect.fn("HoustonTaskSourceStore.settingsOf")(function* (
    projectId: ProjectId,
  ) {
    const result: Array<HoustonTaskSourceSettings> = [];
    for (const provider of ["github_issues", "notion"] as const) {
      const row = yield* settingsRow(projectId, provider);
      const poll = yield* pollRow(projectId, provider);
      const base =
        row === undefined
          ? unsetSettings(projectId, provider)
          : {
              ...unsetSettings(projectId, provider),
              ...settingsFromRow(row),
              revision: row.revision,
            };
      result.push({
        ...base,
        hasCredential: yield* hasCredential(projectId, provider),
        lastSyncAt: poll?.last_sync_at ?? null,
        lastError: poll?.last_error ?? null,
      });
    }
    return result;
  });

  const linksOf = (taskId: number) =>
    sql<LinkRow>`
      SELECT * FROM houston_task_source_links WHERE task_id = ${taskId}
      ORDER BY provider, external_id, source
    `.pipe(
      Effect.map((rows) => rows.map(toLink)),
      Effect.orDie,
    );

  const forgetCredential = (projectId: string, provider: HoustonTaskSourceProvider) =>
    write(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM houston_task_source_credentials
          WHERE project_id = ${projectId} AND provider = ${provider}
        `;
        return { result: undefined, touched: [], events: [] };
      }),
    ).pipe(Effect.orDie);

  // A record whose keychain removal fails stays, so the next startup sweep tries again.
  const projectRemoved = Effect.fn("HoustonTaskSourceStore.projectRemoved")(function* (
    projectId: ProjectId,
  ) {
    const recorded = yield* write(
      Effect.gen(function* () {
        yield* sql`DELETE FROM houston_task_source_settings WHERE project_id = ${projectId}`;
        yield* sql`DELETE FROM houston_task_source_poll WHERE project_id = ${projectId}`;
        const rows = yield* sql<{ readonly provider: HoustonTaskSourceProvider }>`
            SELECT provider FROM houston_task_source_credentials WHERE project_id = ${projectId}
          `;
        return { result: rows, touched: [], events: [] };
      }),
    ).pipe(Effect.orDie);
    for (const { provider } of recorded) {
      yield* keychain.remove(tokenService(projectId, provider), TOKEN_ACCOUNT).pipe(
        Effect.andThen(forgetCredential(projectId, provider)),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Failed to remove the ${provider} token of deleted project ${projectId}.`,
            cause,
          ),
        ),
      );
    }
  });

  return HoustonTaskSourceStore.of({
    write,
    events,
    settingsRow,
    enabledRows: sql<SettingsRow>`
      SELECT * FROM houston_task_source_settings WHERE enabled = 1 ORDER BY project_id, provider
    `.pipe(Effect.orDie),
    pollRow,
    linksOf,
    tokenService,
    hasCredential,
    settingsOf,
    forgetCredential,
    projectRemoved,
  });
});

export const layer = Layer.effect(HoustonTaskSourceStore, make);

/** At startup, removes the sources of projects deleted while a deletion hook could not run. */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskSourceStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const live = new Set(
    (yield* projects.list())
      .filter((project) => project.deletedAt === null)
      .map((project) => project.projectId as string),
  );
  const configured = yield* sql<{ readonly project_id: string }>`
    SELECT project_id FROM houston_task_source_settings
    UNION SELECT project_id FROM houston_task_source_credentials
  `;
  for (const { project_id } of configured) {
    if (!live.has(project_id)) yield* store.projectRemoved(project_id as ProjectId);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to remove task sources of deleted projects.", cause),
  ),
);
