import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { resolveSettledThreadTimestamp } from "@houston-app/client-runtime/state/thread-sort";

import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { compactSidebarTimeLabel } from "../components/sidebar/SidebarRowTime";
import type { ThreadStatusKind } from "../components/ui/thread-state-glyph";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { ThreadRowState } from "./sidebarModel";

export type { ThreadStatusKind };

/**
 * The word a thread's status line shows. It says why a thread needs you
 * (Approval, Input, Request) or why it is running quietly (Goal, Waiting)
 * instead of collapsing both into one label.
 */
export function threadStatusWord(
  thread: EnvironmentThreadShell,
  state: ThreadRowState,
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

const STATUS_KIND_BY_WORD: Readonly<Record<string, ThreadStatusKind>> = {
  Approval: "approval",
  Input: "input",
  Request: "request",
  "Needs you": "needs",
  Failed: "failed",
  Limited: "limited",
  Waiting: "waiting",
  Running: "running",
  Goal: "goal",
  Back: "back",
  Ready: "ready",
};

/** The status kind of a thread: the glyph and the word of its row both follow it. */
export function threadStatusKind(
  thread: EnvironmentThreadShell,
  state: ThreadRowState,
): ThreadStatusKind {
  const word = threadStatusWord(thread, state);
  return word === null ? "idle" : (STATUS_KIND_BY_WORD[word] ?? "idle");
}

/** When a Closed row was closed, in the rail's compact age: "Closed 2h". */
export function closedAgeLabel(thread: EnvironmentThreadShell, nowMs: number): string {
  const closedAt = resolveSettledThreadTimestamp(thread);
  if (closedAt === null) return "Closed";
  return `Closed ${compactSidebarTimeLabel(formatRelativeTimeLabel(closedAt, nowMs))}`;
}
