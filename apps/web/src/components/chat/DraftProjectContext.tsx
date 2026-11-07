import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { useState, type ReactNode } from "react";

import { resolveGridThreadState, resolveRowPullRequest } from "~/grid/sidebar";
import { gridThreadStatusKind } from "~/grid/statusWord";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { SidebarRowTime, threadTimeTimestamp } from "../sidebar/SidebarRowTime";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  ThreadStatusKindGlyph,
  threadStatusKindTextClass,
  type ThreadStatusKind,
} from "../ui/thread-state-glyph";
import {
  DRAFT_PROJECT_CONTEXT_CHIP_CLS,
  DRAFT_PROJECT_CONTEXT_CLS,
  DRAFT_PROJECT_CONTEXT_LIST_CLS,
  DRAFT_PROJECT_CONTEXT_ROW_CLS,
  DRAFT_PROJECT_CONTEXT_TITLE_CLS,
} from "../ui/thread-header-recipes";

const RECENT_THREAD_COUNT = 3;

/** One status mark, painted in its family's ink: the glyph set never carries colour itself. */
function StatusGlyph({ kind }: { readonly kind: ThreadStatusKind }) {
  return (
    <span
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center",
        threadStatusKindTextClass(kind),
      )}
    >
      <ThreadStatusKindGlyph kind={kind} />
    </span>
  );
}

/** The families a chip filters the list to; each one is a count the card states. */
type ContextFilter = "running" | "input" | "approval" | "pullRequests";

interface DraftProjectContextProps {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}

function hasOpenPullRequest(thread: EnvironmentThreadShell): boolean {
  const pullRequest = resolveRowPullRequest(thread);
  return pullRequest?.state === "open" || pullRequest?.state === "draft";
}

function matchesFilter(thread: EnvironmentThreadShell, filter: ContextFilter): boolean {
  switch (filter) {
    case "running":
      return resolveSidebarThreadStatus(thread) === "working";
    case "input":
      return resolveSidebarThreadStatus(thread) === "input";
    case "approval":
      return resolveSidebarThreadStatus(thread) === "approval";
    case "pullRequests":
      return hasOpenPullRequest(thread);
  }
}

/** Input first, then approval, failed and back, then the running family, then the rest. */
const STATUS_ORDER: Record<ThreadStatusKind, number> = {
  input: 0,
  request: 0,
  approval: 1,
  needs: 1,
  failed: 2,
  limited: 2,
  back: 3,
  running: 4,
  goal: 4,
  waiting: 4,
  ready: 5,
  idle: 6,
  closed: 6,
};

interface ContextEntry {
  readonly thread: EnvironmentThreadShell;
  readonly kind: ThreadStatusKind;
}

function compareEntries(left: ContextEntry, right: ContextEntry): number {
  const byStatus = STATUS_ORDER[left.kind] - STATUS_ORDER[right.kind];
  if (byStatus !== 0) return byStatus;
  const byTime =
    Date.parse(threadTimeTimestamp(right.thread)) - Date.parse(threadTimeTimestamp(left.thread));
  if (byTime !== 0) return byTime;
  return left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0;
}

/**
 * The quiet project summary above the new-thread composer: attention counts as filter chips and
 * the three threads the user should see first. Every row carries its status glyph.
 */
export function DraftProjectContext({ threads, onOpenThread }: DraftProjectContextProps) {
  const nowMinute = useNowMinute();
  const [activeFilter, setActiveFilter] = useState<ContextFilter | null>(null);
  if (threads.length === 0) return null;

  const nowIso = `${nowMinute}:00.000Z`;
  const entries: ReadonlyArray<ContextEntry> = threads.map((thread) => {
    const state = resolveGridThreadState(thread, nowIso);
    return { thread, kind: gridThreadStatusKind(thread, state) };
  });
  const counts = {
    running: threads.filter((thread) => matchesFilter(thread, "running")).length,
    input: threads.filter((thread) => matchesFilter(thread, "input")).length,
    approval: threads.filter((thread) => matchesFilter(thread, "approval")).length,
    pullRequests: threads.filter(hasOpenPullRequest).length,
  };
  const visible = entries
    .filter(({ thread }) => activeFilter === null || matchesFilter(thread, activeFilter))
    .toSorted(compareEntries)
    .slice(0, RECENT_THREAD_COUNT);

  const toggleFilter = (filter: ContextFilter) => {
    setActiveFilter((current) => (current === filter ? null : filter));
  };

  const chip = (
    filter: ContextFilter,
    count: number,
    label: string,
    glyph: ReactNode,
  ): ReactNode => {
    if (count === 0) return null;
    return (
      <button
        key={filter}
        type="button"
        aria-pressed={activeFilter === filter}
        onClick={() => toggleFilter(filter)}
        className={DRAFT_PROJECT_CONTEXT_CHIP_CLS}
      >
        {glyph}
        <span>
          {count} {label}
        </span>
      </button>
    );
  };

  return (
    <section
      aria-label="Project context"
      data-draft-project-context=""
      className={DRAFT_PROJECT_CONTEXT_CLS}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {chip("running", counts.running, "running", <StatusGlyph kind="running" />)}
        {chip("input", counts.input, "needs input", <StatusGlyph kind="input" />)}
        {chip("approval", counts.approval, "needs approval", <StatusGlyph kind="approval" />)}
        {chip(
          "pullRequests",
          counts.pullRequests,
          counts.pullRequests === 1 ? "open PR" : "open PRs",
          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 shrink-0" />,
        )}
      </div>
      {visible.length > 0 ? (
        <ul className={DRAFT_PROJECT_CONTEXT_LIST_CLS}>
          {visible.map(({ thread, kind }) => {
            const threadRef = scopeThreadRef(thread.environmentId, thread.id);
            return (
              <li key={thread.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenThread(threadRef)}
                  aria-label={`Open thread: ${thread.title}`}
                  className={DRAFT_PROJECT_CONTEXT_ROW_CLS}
                >
                  <StatusGlyph kind={kind} />
                  <span className={DRAFT_PROJECT_CONTEXT_TITLE_CLS}>{thread.title}</span>
                  <SidebarRowTime timestamp={threadTimeTimestamp(thread)} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
