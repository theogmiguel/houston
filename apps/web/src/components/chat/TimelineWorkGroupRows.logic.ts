import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { ThreadStatusPill } from "../Sidebar.logic";

/**
 * The status to show instead of Running: the sidebar's own pill when the thread
 * waits on the user. A waiting turn is still timed, but it is not work.
 */
export function resolveBlockedThreadStatus(pill: ThreadStatusPill | null): ThreadStatusPill | null {
  return pill !== null && pill.state === "needs" ? pill : null;
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}
