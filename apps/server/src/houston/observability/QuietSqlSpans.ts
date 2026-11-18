import type { EffectTraceRecord } from "@houston-app/shared/observability";

const STATEMENT_SPANS: ReadonlySet<string> = new Set([
  "sqlite",
  "BEGIN",
  "COMMIT",
  "sql.transaction",
]);

/**
 * Below this a statement says nothing a diagnosis needs. Measured on a desktop running agents:
 * statements under 5 ms were 41-47% of the local trace's bytes, and nearly all of them were
 * under 1 ms, so rotation kept about half the history it could.
 */
const QUIET_STATEMENT_MS = 5;

/**
 * Whether a span goes to the server's local trace file. A fast, successful statement that did not
 * wait on the database lock is left out; slow, failed and lock-waiting ones stay, and exports get
 * every span. Trace diagnostics count statements from the file, so they count only those kept.
 */
export const keepServerTraceRecord = (record: EffectTraceRecord): boolean => {
  if (!STATEMENT_SPANS.has(record.name)) return true;
  if (record.exit._tag !== "Success") return true;
  const lockWaitMs = record.attributes["db.lock_wait_ms"];
  const waited = typeof lockWaitMs === "number" && lockWaitMs >= QUIET_STATEMENT_MS;
  return waited || record.durationMs >= QUIET_STATEMENT_MS;
};
