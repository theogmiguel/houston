// The merge queue tables. Writes are serialised and each publishes the project it changed, in
// commit order; a deleted project's rows go with its deletion hook.
import type { ProjectId } from "@t3tools/contracts";
import {
  HOUSTON_MERGE_QUEUE_LIMITS,
  type HoustonMergeQueueAway,
  type HoustonMergeQueueFailure,
  type HoustonMergeQueueGitHubHold,
  type HoustonMergeQueueHandOff,
  type HoustonMergeQueueLogEntry,
  type HoustonMergeQueueSettings,
  type HoustonMergeQueueVerification,
} from "@t3tools/contracts/houston/mergeQueue";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { CheckedSettings, Facts, HandOffCache, QueueRow, Stacked } from "./rules.ts";

interface HandOffJson {
  /** The hand-off of the newest visible answer, which the snapshot shows. */
  readonly mode: HoustonMergeQueueHandOff;
  readonly baseRef: string;
  readonly bases: HandOffCache;
}

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** A change to one project's queue; null for the global pause. */
export interface StoreEvent {
  readonly projectId: string | null;
}

export type NewLogRow = Omit<HoustonMergeQueueLogEntry, "id" | "at">;

export interface NewEntry {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly repository: string;
  readonly url: string;
  readonly title: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string | null;
  readonly dependsOn: number | null;
  readonly ownerThreadId: string | null;
  readonly facts: Facts;
}

interface EntryRow {
  readonly project_id: string;
  readonly number: number;
  readonly repository: string;
  readonly url: string;
  readonly title: string | null;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly base_ref: string | null;
  readonly depends_on: number | null;
  readonly owner_thread_id: string | null;
  readonly position: number;
  readonly enqueued_at: string;
  readonly facts_json: string | null;
  readonly verification_json: string | null;
  readonly failure_json: string | null;
  readonly stacked_json: string | null;
  readonly github_json: string | null;
}

interface SettingsRow {
  readonly merge_when_verified: number;
  readonly verification_command: string;
  readonly time_limit_minutes: number;
  readonly paused: number;
  readonly acknowledged_at: string | null;
  readonly hand_off_json: string | null;
  readonly revision: number;
}

interface LogRow {
  readonly id: number;
  readonly kind: HoustonMergeQueueLogEntry["kind"];
  readonly number: number;
  readonly repository: string;
  readonly url: string;
  readonly title: string | null;
  readonly ref_name: string | null;
  readonly old_sha: string | null;
  readonly new_sha: string | null;
  readonly head_sha: string | null;
  readonly fork_sha: string | null;
  readonly method: HoustonMergeQueueLogEntry["method"];
  readonly detail: string | null;
  readonly unattended: number;
  readonly at: string;
}

const parse = <A>(text: string | null): A | null =>
  text === null ? null : (JSON.parse(text) as A);
const json = (value: unknown) =>
  value === null || value === undefined ? null : JSON.stringify(value);

const toRow = (row: EntryRow): QueueRow => ({
  projectId: row.project_id as ProjectId,
  number: row.number,
  repository: row.repository,
  url: row.url,
  title: row.title,
  headRef: row.head_ref,
  headSha: row.head_sha,
  baseRef: row.base_ref,
  dependsOn: row.depends_on,
  ownerThreadId: row.owner_thread_id,
  position: row.position,
  enqueuedAt: row.enqueued_at,
  facts: parse<Facts>(row.facts_json),
  verification: parse<HoustonMergeQueueVerification>(row.verification_json),
  failure: parse<HoustonMergeQueueFailure>(row.failure_json),
  stacked: parse<Stacked>(row.stacked_json),
  github: parse(row.github_json),
});

const toLog = (row: LogRow): HoustonMergeQueueLogEntry => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  repository: row.repository,
  url: row.url,
  title: row.title,
  refName: row.ref_name,
  oldSha: row.old_sha,
  newSha: row.new_sha,
  headSha: row.head_sha,
  forkSha: row.fork_sha,
  method: row.method,
  detail: row.detail,
  unattended: row.unattended !== 0,
  at: row.at,
});

export class HoustonMergeQueueStore extends Context.Service<
  HoustonMergeQueueStore,
  {
    readonly events: PubSub.PubSub<StoreEvent>;
    /** Asks the runner for a pass before its next minute. */
    readonly wake: Effect.Effect<void>;
    readonly wakes: Queue.Queue<void>;
    /** Tells subscribers a project's view changed without a row changing (the slot). */
    readonly touch: (projectId: string) => Effect.Effect<void>;
    /** A project's entries by position. */
    readonly rows: (projectId: string) => Effect.Effect<ReadonlyArray<QueueRow>>;
    readonly projectsWithEntries: Effect.Effect<ReadonlyArray<ProjectId>>;
    /** Appends at the tail, or keeps a queued entry's place and replaces its dependency. */
    readonly upsertEntry: (entry: NewEntry) => Effect.Effect<void>;
    readonly removeEntry: (projectId: string, number: number) => Effect.Effect<boolean>;
    /** Records a read; `publish` false stores it without telling subscribers. */
    readonly setFacts: (
      projectId: string,
      number: number,
      facts: Facts,
      publish: boolean,
    ) => Effect.Effect<void>;
    readonly setVerification: (
      projectId: string,
      number: number,
      verification: HoustonMergeQueueVerification | null,
    ) => Effect.Effect<void>;
    readonly setFailure: (
      projectId: string,
      number: number,
      failure: HoustonMergeQueueFailure | null,
    ) => Effect.Effect<void>;
    /** Removes a merged entry's dependency from its dependents, remembering it as `stacked`. */
    readonly clearDependency: (
      projectId: string,
      number: number,
      stacked: Stacked | null,
    ) => Effect.Effect<void>;
    readonly settings: (projectId: ProjectId) => Effect.Effect<HoustonMergeQueueSettings>;
    readonly acknowledgedAt: (projectId: string) => Effect.Effect<string | null>;
    readonly handOff: (projectId: string) => Effect.Effect<HoustonMergeQueueHandOff | null>;
    /** The hand-off GitHub's last visible answer chose, per base branch. */
    readonly handOffs: (projectId: string) => Effect.Effect<HandOffCache>;
    /** Remembers the hand-off for a base; publishes only when it changed. */
    readonly recordHandOff: (
      projectId: string,
      baseRef: string,
      mode: HoustonMergeQueueHandOff,
    ) => Effect.Effect<void>;
    readonly setGitHub: (
      projectId: string,
      number: number,
      hold: HoustonMergeQueueGitHubHold | null,
    ) => Effect.Effect<void>;
    readonly setOwner: (projectId: string, number: number, threadId: string) => Effect.Effect<void>;
    readonly acknowledge: (projectId: string) => Effect.Effect<void>;
    /** Every log row of one pull request, oldest first. */
    readonly logOf: (
      projectId: string,
      number: number,
    ) => Effect.Effect<ReadonlyArray<HoustonMergeQueueLogEntry>>;
    /** Checks, then stores, with no write between; a new command drops its verifications. */
    readonly saveSettings: <E>(
      projectId: ProjectId,
      check: (current: HoustonMergeQueueSettings) => CheckedSettings | E,
      isRefusal: (value: CheckedSettings | E) => value is E,
    ) => Effect.Effect<void, E>;
    readonly setPaused: (projectId: string, paused: boolean) => Effect.Effect<void>;
    readonly globalPaused: Effect.Effect<boolean>;
    readonly setGlobalPaused: (paused: boolean) => Effect.Effect<void>;
    /** Appends a log row and deletes rows older than the log keeps. */
    readonly appendLog: (projectId: string, row: NewLogRow) => Effect.Effect<void>;
    /** Newest first. */
    readonly log: (
      projectId: string,
      since: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<HoustonMergeQueueLogEntry>>;
    readonly away: (projectId: string) => Effect.Effect<HoustonMergeQueueAway>;
    readonly projectRemoved: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("houston/houston/mergeQueue/Store/HoustonMergeQueueStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* PubSub.unbounded<StoreEvent>();
  const wakes = yield* Queue.sliding<void>(1);
  const lock = yield* Semaphore.make(1);

  const write = <A>(
    projectId: string | null,
    body: Effect.Effect<A, SqlError.SqlError>,
    publish = true,
  ) =>
    lock
      .withPermits(1)(sql.withTransaction(body).pipe(Effect.orDie))
      .pipe(Effect.tap(() => (publish ? PubSub.publish(events, { projectId }) : Effect.void)));

  const rows = (projectId: string) =>
    sql<EntryRow>`
      SELECT * FROM houston_merge_queue_entries WHERE project_id = ${projectId}
      ORDER BY position, number
    `.pipe(
      Effect.map((found) => found.map(toRow)),
      Effect.orDie,
    );

  const settingsRow = (projectId: string) =>
    sql<SettingsRow>`
      SELECT * FROM houston_merge_queue_settings WHERE project_id = ${projectId}
    `.pipe(
      Effect.map((found) => found[0]),
      Effect.orDie,
    );

  const upsertEntry = (entry: NewEntry) =>
    write(
      entry.projectId,
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO houston_merge_queue_entries (
            project_id, number, repository, url, title, head_ref, head_sha, base_ref, depends_on,
            owner_thread_id, position, enqueued_at, facts_json
          ) VALUES (
            ${entry.projectId}, ${entry.number}, ${entry.repository}, ${entry.url}, ${entry.title},
            ${entry.headRef}, ${entry.headSha}, ${entry.baseRef}, ${entry.dependsOn},
            ${entry.ownerThreadId},
            (SELECT COALESCE(MAX(position), 0) + 1 FROM houston_merge_queue_entries
              WHERE project_id = ${entry.projectId}),
            ${now}, ${json(entry.facts)}
          )
          ON CONFLICT (project_id, number) DO UPDATE SET depends_on = excluded.depends_on,
            owner_thread_id = COALESCE(excluded.owner_thread_id, owner_thread_id),
            repository = excluded.repository, url = excluded.url, title = excluded.title,
            head_ref = excluded.head_ref, head_sha = excluded.head_sha,
            base_ref = excluded.base_ref, facts_json = excluded.facts_json
        `;
      }),
    );

  const removeEntry = (projectId: string, number: number) =>
    write(
      projectId,
      sql<{ readonly number: number }>`
        DELETE FROM houston_merge_queue_entries
        WHERE project_id = ${projectId} AND number = ${number} RETURNING number
      `.pipe(Effect.map((removed) => removed.length > 0)),
    );

  const setFacts = (projectId: string, number: number, facts: Facts, publish: boolean) =>
    write(
      projectId,
      // A read that failed keeps the entry's last known head, base and title.
      facts.error === null
        ? sql`
            UPDATE houston_merge_queue_entries SET facts_json = ${json(facts)},
              head_sha = ${facts.headSha}, head_ref = ${facts.headRef},
              base_ref = ${facts.baseRef}, title = ${facts.title}
            WHERE project_id = ${projectId} AND number = ${number}
          `
        : sql`
            UPDATE houston_merge_queue_entries SET facts_json = ${json(facts)}
            WHERE project_id = ${projectId} AND number = ${number}
          `,
      publish,
    );

  const setColumn =
    (column: "verification_json" | "failure_json") =>
    (projectId: string, number: number, value: unknown) =>
      write(
        projectId,
        sql`
          UPDATE houston_merge_queue_entries SET ${sql(column)} = ${json(value)}
          WHERE project_id = ${projectId} AND number = ${number}
        `,
      );

  const clearDependency = (projectId: string, number: number, stacked: Stacked | null) =>
    write(
      projectId,
      sql`
        UPDATE houston_merge_queue_entries SET depends_on = NULL,
          stacked_json = COALESCE(${json(stacked)}, stacked_json)
        WHERE project_id = ${projectId} AND depends_on = ${number}
      `,
    );

  const settings = (projectId: ProjectId) =>
    settingsRow(projectId).pipe(
      Effect.map((row): HoustonMergeQueueSettings => ({
        projectId,
        mergeWhenVerified: (row?.merge_when_verified ?? 0) !== 0,
        verificationCommand: row?.verification_command ?? "",
        timeLimitMinutes:
          row?.time_limit_minutes ?? HOUSTON_MERGE_QUEUE_LIMITS.defaultTimeLimitMinutes,
        paused: (row?.paused ?? 0) !== 0,
        revision: row?.revision ?? 0,
      })),
    );

  const saveSettings = <E>(
    projectId: ProjectId,
    check: (current: HoustonMergeQueueSettings) => CheckedSettings | E,
    isRefusal: (value: CheckedSettings | E) => value is E,
  ) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const checked = check(yield* settings(projectId));
          if (isRefusal(checked)) return yield* Effect.fail(checked);
          yield* sql.withTransaction(storeSettings(projectId, checked)).pipe(Effect.orDie);
        }),
      )
      .pipe(Effect.tap(() => PubSub.publish(events, { projectId })));

  const storeSettings = Effect.fn("HoustonMergeQueueStore.storeSettings")(function* (
    projectId: ProjectId,
    checked: CheckedSettings,
  ) {
    const before = yield* settingsRow(projectId);
    yield* sql`
          INSERT INTO houston_merge_queue_settings (
            project_id, merge_when_verified, verification_command, time_limit_minutes, revision
          ) VALUES (
            ${projectId}, ${checked.mergeWhenVerified ? 1 : 0}, ${checked.verificationCommand},
            ${checked.timeLimitMinutes}, 1
          )
          ON CONFLICT (project_id) DO UPDATE SET
            merge_when_verified = excluded.merge_when_verified,
            verification_command = excluded.verification_command,
            time_limit_minutes = excluded.time_limit_minutes, revision = revision + 1
        `;
    if ((before?.verification_command ?? "") !== checked.verificationCommand) {
      yield* sql`
            UPDATE houston_merge_queue_entries SET verification_json = NULL
            WHERE project_id = ${projectId}
          `;
    }
  });

  const setPaused = (projectId: string, paused: boolean) =>
    write(
      projectId,
      sql`
        INSERT INTO houston_merge_queue_settings (project_id, paused) VALUES (${projectId}, ${paused ? 1 : 0})
        ON CONFLICT (project_id) DO UPDATE SET paused = excluded.paused
      `,
    );

  const globalPaused = sql<{ readonly paused: number }>`
    SELECT paused FROM houston_merge_queue_global WHERE id = 1
  `.pipe(
    Effect.map((found) => (found[0]?.paused ?? 0) !== 0),
    Effect.orDie,
  );

  const setGlobalPaused = (paused: boolean) =>
    write(
      null,
      sql`
        INSERT INTO houston_merge_queue_global (id, paused) VALUES (1, ${paused ? 1 : 0})
        ON CONFLICT (id) DO UPDATE SET paused = excluded.paused
      `,
    );

  const appendLog = (projectId: string, row: NewLogRow) =>
    write(
      projectId,
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const cutoff = DateTime.formatIso(
          DateTime.subtract(now, { days: HOUSTON_MERGE_QUEUE_LIMITS.logDays }),
        );
        yield* sql`DELETE FROM houston_merge_queue_log WHERE at < ${cutoff}`;
        yield* sql`
          INSERT INTO houston_merge_queue_log (
            project_id, kind, number, repository, url, title, ref_name, old_sha, new_sha, head_sha,
            fork_sha, method, detail, unattended, at
          ) VALUES (
            ${projectId}, ${row.kind}, ${row.number}, ${row.repository}, ${row.url}, ${row.title},
            ${row.refName}, ${row.oldSha}, ${row.newSha}, ${row.headSha}, ${row.forkSha},
            ${row.method}, ${row.detail}, ${row.unattended ? 1 : 0}, ${DateTime.formatIso(now)}
          )
        `;
      }),
    );

  const log = (projectId: string, since: string, limit: number) =>
    sql<LogRow>`
      SELECT * FROM houston_merge_queue_log WHERE project_id = ${projectId} AND at >= ${since}
      ORDER BY id DESC LIMIT ${limit}
    `.pipe(
      Effect.map((found) => found.map(toLog)),
      Effect.orDie,
    );

  const acknowledgedAt = (projectId: string) =>
    settingsRow(projectId).pipe(Effect.map((row) => row?.acknowledged_at ?? null));

  const away = Effect.fn("HoustonMergeQueueStore.away")(function* (projectId: string) {
    const since = (yield* acknowledgedAt(projectId)) ?? "";
    const counts = yield* sql<{ readonly kind: string; readonly n: number }>`
      SELECT kind, COUNT(*) AS n FROM houston_merge_queue_log
      WHERE project_id = ${projectId} AND unattended = 1 AND at > ${since}
        AND kind IN ('merge', 'park')
      GROUP BY kind
    `.pipe(Effect.orDie);
    const of = (kind: string) => counts.find((row) => row.kind === kind)?.n ?? 0;
    return { merged: of("merge"), parked: of("park") };
  });

  const touch = Effect.fn("HoustonMergeQueueStore.touch")(function* (projectId: string) {
    yield* PubSub.publish(events, { projectId });
  });

  const handOffJson = (projectId: string) =>
    settingsRow(projectId).pipe(
      Effect.map((row) => parse<HandOffJson>(row?.hand_off_json ?? null)),
    );

  const handOff = (projectId: string) =>
    handOffJson(projectId).pipe(Effect.map((stored) => stored?.mode ?? null));

  const handOffs = (projectId: string) =>
    handOffJson(projectId).pipe(Effect.map((stored): HandOffCache => stored?.bases ?? {}));

  const recordHandOff = (projectId: string, baseRef: string, mode: HoustonMergeQueueHandOff) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* handOffJson(projectId);
          if (stored?.mode === mode && stored.bases?.[baseRef] === mode) return false;
          const next: HandOffJson = { mode, baseRef, bases: { ...stored?.bases, [baseRef]: mode } };
          yield* sql
            .withTransaction(sql`
          INSERT INTO houston_merge_queue_settings (project_id, hand_off_json)
          VALUES (${projectId}, ${json(next)})
          ON CONFLICT (project_id) DO UPDATE SET hand_off_json = excluded.hand_off_json
        `)
            .pipe(Effect.orDie);
          return true;
        }),
      )
      .pipe(
        Effect.flatMap((changed) =>
          changed ? PubSub.publish(events, { projectId }).pipe(Effect.asVoid) : Effect.void,
        ),
      );

  const setGitHub = (projectId: string, number: number, hold: HoustonMergeQueueGitHubHold | null) =>
    write(
      projectId,
      sql`
        UPDATE houston_merge_queue_entries SET github_json = ${json(hold)}
        WHERE project_id = ${projectId} AND number = ${number}
      `,
    );

  const setOwner = (projectId: string, number: number, threadId: string) =>
    write(
      projectId,
      sql`
        UPDATE houston_merge_queue_entries SET owner_thread_id = ${threadId}
        WHERE project_id = ${projectId} AND number = ${number}
      `,
    );

  const acknowledge = (projectId: string) =>
    write(
      projectId,
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO houston_merge_queue_settings (project_id, acknowledged_at) VALUES (${projectId}, ${now})
          ON CONFLICT (project_id) DO UPDATE SET acknowledged_at = excluded.acknowledged_at
        `;
      }),
    );

  const logOf = (projectId: string, number: number) =>
    sql<LogRow>`
      SELECT * FROM houston_merge_queue_log WHERE project_id = ${projectId} AND number = ${number}
      ORDER BY id
    `.pipe(
      Effect.map((found) => found.map(toLog)),
      Effect.orDie,
    );

  const projectRemoved = (projectId: ProjectId) =>
    write(
      projectId,
      Effect.gen(function* () {
        yield* sql`DELETE FROM houston_merge_queue_entries WHERE project_id = ${projectId}`;
        yield* sql`DELETE FROM houston_merge_queue_settings WHERE project_id = ${projectId}`;
        yield* sql`DELETE FROM houston_merge_queue_log WHERE project_id = ${projectId}`;
      }),
    );

  return HoustonMergeQueueStore.of({
    events,
    wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
    wakes,
    touch,
    rows,
    projectsWithEntries: sql<{ readonly project_id: string }>`
      SELECT DISTINCT project_id FROM houston_merge_queue_entries ORDER BY project_id
    `.pipe(
      Effect.map((found) => found.map((row) => row.project_id as ProjectId)),
      Effect.orDie,
    ),
    upsertEntry,
    removeEntry,
    setFacts,
    setVerification: setColumn("verification_json"),
    setFailure: setColumn("failure_json"),
    clearDependency,
    settings,
    acknowledgedAt,
    handOff,
    handOffs,
    recordHandOff,
    setGitHub,
    setOwner,
    acknowledge,
    logOf,
    saveSettings,
    setPaused,
    globalPaused,
    setGlobalPaused,
    appendLog,
    log,
    away,
    projectRemoved,
  });
});

export const layer = Layer.effect(HoustonMergeQueueStore, make);
