import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { getThreadSortTimestamp } from "@houston-app/client-runtime/state/thread-sort";

import { workspaceKeyOf } from "../../grid/gridStore";
import { resolveGridThreadState } from "../../grid/sidebar";
import { gridThreadStatusWord } from "../../grid/statusWord";
import { isSidebarHiddenThread } from "../Sidebar.logic";

/** The attention families the "Needs you" section collects, in the order it lists them. */
export type NeedsYouGroup = "input" | "approval" | "failed" | "back";

export const NEEDS_YOU_GROUPS: ReadonlyArray<NeedsYouGroup> = [
  "input",
  "approval",
  "failed",
  "back",
];

export interface NeedsYouEntry {
  readonly thread: EnvironmentThreadShell;
  readonly group: NeedsYouGroup;
}

function needsYouGroupOf(thread: EnvironmentThreadShell, nowIso: string): NeedsYouGroup | null {
  const state = resolveGridThreadState(thread, nowIso);
  switch (gridThreadStatusWord(thread, state)) {
    case "Input":
      return "input";
    case "Approval":
      return "approval";
    case "Failed":
      return "failed";
    case "Back":
      return "back";
    default:
      return null;
  }
}

function isExcludedFromNeedsYou(thread: EnvironmentThreadShell, nowIso: string): boolean {
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    isSidebarHiddenThread(thread) ||
    effectiveSnoozed(thread, { now: nowIso })
  );
}

/** Whether one thread belongs in the "Needs you" section, ignoring which project it is in. */
export function isNeedsYouThread(thread: EnvironmentThreadShell, nowIso: string): boolean {
  return !isExcludedFromNeedsYou(thread, nowIso) && needsYouGroupOf(thread, nowIso) !== null;
}

/**
 * The threads on the rail that wait on the user, across every open project: Input, Approval,
 * Failed and Back, in that order, newest activity first within a family. Closed, held, archived
 * and subagent threads never belong here.
 */
export function buildNeedsYouEntries(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nowIso: string;
  readonly workspaceKeys: ReadonlySet<string>;
}): NeedsYouEntry[] {
  const byGroup = new Map<NeedsYouGroup, NeedsYouEntry[]>();
  for (const thread of input.threads) {
    if (!input.workspaceKeys.has(workspaceKeyOf(thread.environmentId, thread.projectId))) continue;
    if (isExcludedFromNeedsYou(thread, input.nowIso)) continue;
    const group = needsYouGroupOf(thread, input.nowIso);
    if (group === null) continue;
    const entries = byGroup.get(group) ?? [];
    entries.push({ thread, group });
    byGroup.set(group, entries);
  }
  return NEEDS_YOU_GROUPS.flatMap((group) =>
    (byGroup.get(group) ?? []).toSorted(
      (left, right) =>
        getThreadSortTimestamp(right.thread, "updated_at") -
        getThreadSortTimestamp(left.thread, "updated_at"),
    ),
  );
}
