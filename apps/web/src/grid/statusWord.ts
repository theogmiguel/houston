import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { resolveSettledThreadTimestamp } from "@houston-app/client-runtime/state/thread-sort";

import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { compactSidebarTimeLabel } from "../components/sidebar/SidebarRowTime";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { GridThreadState } from "./sidebar";

/**
 * The word a thread's status line shows. It says why a thread needs you
 * (Approval, Input, Request) or why it is running quietly (Goal, Waiting)
 * instead of collapsing both into one label.
 */
export function gridThreadStatusWord(
  thread: EnvironmentThreadShell,
  state: GridThreadState,
): string | null {
  switch (state) {
    case "idle":
      return null;
    case "back":
      return "Back";
    case "ready":
      return "Ready";
    case "needs":
      if (thread.hasPendingApprovals) return "Approval";
      if (thread.hasPendingUserInput) return "Input";
      if (thread.pendingSubagentRequest != null) return "Request";
      return "Needs you";
    case "failed":
      return resolveSidebarThreadStatus(thread) === "limited" ? "Limited" : "Failed";
    case "running":
      if (resolveThreadStatusPill({ thread })?.label === "Waiting") return "Waiting";
      return thread.goal?.status === "active" ? "Goal" : "Running";
  }
}

/** When a Closed row was closed, in the rail's compact age: "Closed 2h". */
export function closedAgeLabel(thread: EnvironmentThreadShell, nowMs: number): string {
  const closedAt = resolveSettledThreadTimestamp(thread);
  if (closedAt === null) return "Closed";
  return `Closed ${compactSidebarTimeLabel(formatRelativeTimeLabel(closedAt, nowMs))}`;
}
