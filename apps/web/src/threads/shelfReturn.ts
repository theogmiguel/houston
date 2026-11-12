import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";

/**
 * What dropping a shelf row into the rail does: a held thread wakes and a closed one reopens, so
 * it returns to the grid it left. Null for a thread that is on neither shelf.
 */
export function shelfReturnAction(
  thread: Pick<
    EnvironmentThreadShell,
    "snoozedUntil" | "settledOverride" | "archivedAt" | "deletedAt"
  >,
  nowIso: string,
): "wake" | "reopen" | null {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  if (effectiveSnoozed(thread as never, { now: nowIso })) return "wake";
  return thread.settledOverride === "settled" ? "reopen" : null;
}
