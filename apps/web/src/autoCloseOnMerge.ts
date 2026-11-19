import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import type { ScopedThreadRef } from "@houston-app/contracts";

import { isSidebarHiddenThread } from "./components/Sidebar.logic";

const LOCALLY_SETTLED_TTL_MS = 30_000;

/** Threads this client closed, kept briefly so their own settle never raises the auto-close toast. */
const locallySettledAt = new Map<string, number>();

function pruneLocallySettled(now: number): void {
  for (const [key, at] of locallySettledAt) {
    if (now - at > LOCALLY_SETTLED_TTL_MS) locallySettledAt.delete(key);
  }
}

export function noteLocallySettled(ref: ScopedThreadRef, now = Date.now()): string {
  pruneLocallySettled(now);
  const key = scopedThreadKey(ref);
  locallySettledAt.set(key, now);
  return key;
}

export function forgetLocallySettled(key: string): void {
  locallySettledAt.delete(key);
}

export function locallySettledThreadKeys(now = Date.now()): ReadonlySet<string> {
  pruneLocallySettled(now);
  return new Set(locallySettledAt.keys());
}

function threadKeyOf(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function hasMergedPullRequest(thread: EnvironmentThreadShell): boolean {
  return (thread.pullRequests ?? []).some(
    (link) => link.snapshot?.state === "merged" || link.snapshot?.mergedAt != null,
  );
}

/**
 * Whether a live shell update closed the thread because its pull request merged. The server does
 * not record the settle cause, so this infers it: the thread was open before, is closed now, this
 * client did not close it, and one of its pull requests merged.
 */
export function detectAutoClosedOnMerge(
  previous: EnvironmentThreadShell,
  next: EnvironmentThreadShell,
  locallySettledIds: ReadonlySet<string>,
): boolean {
  if (previous.settledOverride === "settled" || next.settledOverride !== "settled") return false;
  if (previous.id !== next.id || previous.environmentId !== next.environmentId) return false;
  if (next.archivedAt !== null || next.deletedAt !== null) return false;
  if (isSidebarHiddenThread(next)) return false;
  if (locallySettledIds.has(threadKeyOf(next))) return false;
  return hasMergedPullRequest(next);
}
