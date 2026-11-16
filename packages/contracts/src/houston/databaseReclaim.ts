import * as Schema from "effect/Schema";

/**
 * Free space inside the database file from which Settings offers "Reclaim now". The background
 * pass returns about 4 MiB a minute, so this is roughly a quarter hour of waiting.
 */
export const HOUSTON_DATABASE_RECLAIM_OFFER_BYTES = 64 * 1024 ** 2;

export const HoustonDatabaseReclaimResult = Schema.Struct({
  /** What this request returned to the file system. */
  reclaimedBytes: Schema.Number,
  /** Free space still inside the file; above zero when the request hit its time limit. */
  remainingBytes: Schema.Number,
  databaseBytes: Schema.Number,
  /** The time limit for one request, in seconds, so a partial result can say what stopped it. */
  timeLimitSeconds: Schema.Number,
});
export type HoustonDatabaseReclaimResult = typeof HoustonDatabaseReclaimResult.Type;

export const HoustonDatabaseReclaimErrorKind = Schema.Literals([
  "not-channel-database",
  "needs-offline-repair",
  "insufficient-disk",
  "failed",
]);

/**
 * A refusal. `insufficient-disk` carries `neededBytes` and `freeBytes`; `message` always names
 * the cause and what to do next.
 */
export class HoustonDatabaseReclaimError extends Schema.TaggedError<HoustonDatabaseReclaimError>()(
  "HoustonDatabaseReclaimError",
  {
    kind: HoustonDatabaseReclaimErrorKind,
    message: Schema.String,
    neededBytes: Schema.optional(Schema.Number),
    freeBytes: Schema.optional(Schema.Number),
  },
) {}

/** Whether Settings should offer the one-click reclaim for this database. */
export function shouldOfferDatabaseReclaim(status: {
  readonly incrementalVacuumEnabled: boolean;
  readonly reclaimableBytes: number;
}): boolean {
  return (
    status.incrementalVacuumEnabled &&
    status.reclaimableBytes >= HOUSTON_DATABASE_RECLAIM_OFFER_BYTES
  );
}
