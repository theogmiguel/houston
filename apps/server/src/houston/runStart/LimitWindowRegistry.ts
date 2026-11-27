import type { ProviderInstanceId } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** One provider account window Houston knows about, keyed by instance and model scope. */
export interface LimitWindowRecord {
  readonly providerInstanceId: ProviderInstanceId;
  /** `*` for the account, or a model slug a weekly limit applies to. */
  readonly scope: string;
  /** The reported reset, or null when the provider did not report one. */
  readonly resetAt: string | null;
  readonly observedAt: string;
  /** Test releases already tried with no reset time. */
  readonly testAttempt: number;
  readonly nextTestAt: string | null;
}

const keyOf = (record: Pick<LimitWindowRecord, "providerInstanceId" | "scope">) =>
  `${record.providerInstanceId}\u0000${record.scope}`;

const Record = Schema.Struct({
  provider_instance_id: Schema.String,
  scope: Schema.String,
  reset_at: Schema.NullOr(Schema.String),
  observed_at: Schema.String,
  test_attempt: Schema.Number,
  next_test_at: Schema.NullOr(Schema.String),
});

export interface LimitWindowRegistryShape {
  /** Every stored window; callers decide which are still active for a start. */
  readonly list: Effect.Effect<ReadonlyArray<LimitWindowRecord>>;
  readonly read: (
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<LimitWindowRecord>>;
  /** A limit failure observed on any thread, with the reset the provider reported or null. */
  readonly recordFailure: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly model: string | null;
    readonly resetAt: string | null;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<void>;
  /** A provider-reported usage window at 100% (or its recovery, below 100%). */
  readonly recordReported: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly scope: string;
    readonly resetAt: string | null;
    readonly usedPercent: number;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<void>;
  readonly recordTestAttempt: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly scope: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<string | null>;
  readonly clear: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
}

export class LimitWindowRegistry extends Context.Service<
  LimitWindowRegistry,
  LimitWindowRegistryShape
>()("@houston-app/cli/houston/runStart/LimitWindowRegistry") {}

const decodeRow = Schema.decodeUnknownSync(Record);

function toRecord(row: typeof Record.Type): LimitWindowRecord {
  const decoded = decodeRow(row);
  return {
    providerInstanceId: decoded.provider_instance_id as ProviderInstanceId,
    scope: decoded.scope,
    resetAt: decoded.reset_at,
    observedAt: decoded.observed_at,
    testAttempt: decoded.test_attempt,
    nextTestAt: decoded.next_test_at,
  };
}

const toIso = (now: DateTime.Utc) => DateTime.formatIso(now);

/** 15 minutes, then 30, then every 60 while no reset time is known. */
export function nextTestReleaseAt(observedAtMs: number, attempt: number): number {
  const delayMinutes = attempt <= 0 ? 15 : attempt === 1 ? 30 : 60;
  return observedAtMs + delayMinutes * 60_000;
}

export const layer = Layer.effect(
  LimitWindowRegistry,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cache = yield* Ref.make<ReadonlyMap<string, LimitWindowRecord>>(new Map());

    const reload = Effect.gen(function* () {
      const rows = yield* sql<typeof Record.Type>`
        SELECT provider_instance_id, scope, reset_at, observed_at, test_attempt, next_test_at
        FROM houston_limit_windows
      `;
      const records = rows.map(toRecord);
      yield* Ref.set(cache, new Map(records.map((record) => [keyOf(record), record])));
      return records;
    });

    const list: LimitWindowRegistryShape["list"] = reload.pipe(Effect.orDie);

    const read: LimitWindowRegistryShape["read"] = (providerInstanceId) =>
      list.pipe(
        Effect.map((records) =>
          records.filter((record) => record.providerInstanceId === providerInstanceId),
        ),
      );

    const upsert = Effect.fn("LimitWindowRegistry.upsert")(function* (record: LimitWindowRecord) {
      yield* sql`
          INSERT INTO houston_limit_windows
            (provider_instance_id, scope, reset_at, observed_at, test_attempt, next_test_at)
          VALUES (
            ${record.providerInstanceId},
            ${record.scope},
            ${record.resetAt},
            ${record.observedAt},
            ${record.testAttempt},
            ${record.nextTestAt}
          )
          ON CONFLICT (provider_instance_id, scope) DO UPDATE SET
            reset_at = excluded.reset_at,
            observed_at = excluded.observed_at,
            test_attempt = excluded.test_attempt,
            next_test_at = excluded.next_test_at
        `;
      yield* Ref.update(cache, (current) => new Map(current).set(keyOf(record), record));
    }, Effect.orDie);

    const remove = Effect.fn("LimitWindowRegistry.remove")(function* (
      providerInstanceId: ProviderInstanceId,
      scope?: string,
    ) {
      if (scope === undefined) {
        yield* sql`DELETE FROM houston_limit_windows WHERE provider_instance_id = ${providerInstanceId}`;
      } else {
        yield* sql`DELETE FROM houston_limit_windows WHERE provider_instance_id = ${providerInstanceId} AND scope = ${scope}`;
      }
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        for (const [key, record] of next) {
          if (
            record.providerInstanceId === providerInstanceId &&
            (scope === undefined || record.scope === scope)
          ) {
            next.delete(key);
          }
        }
        return next;
      });
    }, Effect.orDie);

    const recordFailure: LimitWindowRegistryShape["recordFailure"] = Effect.fn(
      "LimitWindowRegistry.recordFailure",
    )(function* (input) {
      const records = yield* read(input.providerInstanceId);
      const scope = input.model ?? "*";
      const existing = records.find((record) => record.scope === scope);
      // A new reset (or a first failure) starts the test-release schedule over.
      const sameWindow =
        existing !== undefined &&
        existing.resetAt === input.resetAt &&
        (input.resetAt !== null || existing.resetAt === null);
      const nowMs = DateTime.toEpochMillis(input.now);
      const record: LimitWindowRecord = {
        providerInstanceId: input.providerInstanceId,
        scope,
        resetAt: input.resetAt,
        observedAt: toIso(input.now),
        testAttempt: sameWindow ? existing.testAttempt : 0,
        nextTestAt:
          input.resetAt === null
            ? sameWindow && existing.nextTestAt !== null
              ? existing.nextTestAt
              : DateTime.formatIso(DateTime.makeUnsafe(nextTestReleaseAt(nowMs, 0)))
            : null,
      };
      yield* upsert(record);
    }, Effect.orDie);

    const recordReported: LimitWindowRegistryShape["recordReported"] = Effect.fn(
      "LimitWindowRegistry.recordReported",
    )(function* (input) {
      if (input.usedPercent < 100) {
        yield* remove(input.providerInstanceId, input.scope);
        return;
      }
      const resetAhead =
        input.resetAt !== null && Date.parse(input.resetAt) > DateTime.toEpochMillis(input.now);
      // Only a window at 100% with a reset ahead is a known limit; a stale 100% with no reset
      // is still a recent limit the account has not cleared.
      if (input.resetAt !== null && !resetAhead) {
        yield* remove(input.providerInstanceId, input.scope);
        return;
      }
      const records = yield* read(input.providerInstanceId);
      const existing = records.find((record) => record.scope === input.scope);
      yield* upsert({
        providerInstanceId: input.providerInstanceId,
        scope: input.scope,
        resetAt: input.resetAt,
        observedAt: toIso(input.now),
        testAttempt: existing?.resetAt === input.resetAt ? (existing?.testAttempt ?? 0) : 0,
        nextTestAt:
          input.resetAt === null
            ? (existing?.nextTestAt ??
              DateTime.formatIso(
                DateTime.makeUnsafe(nextTestReleaseAt(DateTime.toEpochMillis(input.now), 0)),
              ))
            : null,
      });
    }, Effect.orDie);

    const recordTestAttempt: LimitWindowRegistryShape["recordTestAttempt"] = Effect.fn(
      "LimitWindowRegistry.recordTestAttempt",
    )(function* (input) {
      const records = yield* read(input.providerInstanceId);
      const record = records.find((candidate) => candidate.scope === input.scope);
      if (record === undefined) return null;
      const attempt = record.testAttempt + 1;
      const nextTestAt = DateTime.formatIso(
        DateTime.makeUnsafe(nextTestReleaseAt(DateTime.toEpochMillis(input.now), attempt)),
      );
      yield* upsert({ ...record, testAttempt: attempt, nextTestAt });
      return nextTestAt;
    }, Effect.orDie);

    const clear: LimitWindowRegistryShape["clear"] = (providerInstanceId) =>
      remove(providerInstanceId);

    yield* reload;
    return LimitWindowRegistry.of({
      list,
      read,
      recordFailure,
      recordReported,
      recordTestAttempt,
      clear,
    });
  }),
);
