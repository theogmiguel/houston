import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import type { ReactElement } from "react";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";

import { resolveRowPullRequest } from "~/grid/sidebar";
import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "../Sidebar.logic";
import { SidebarRowTime, threadTimeTimestamp } from "../sidebar/SidebarRowTime";
import { SidebarThreadStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DRAFT_PROJECT_CONTEXT_BRANCH_CLS,
  DRAFT_PROJECT_CONTEXT_CLS,
  DRAFT_PROJECT_CONTEXT_LINK_CLS,
  DRAFT_PROJECT_CONTEXT_LIST_CLS,
  DRAFT_PROJECT_CONTEXT_ROW_CLS,
  DRAFT_PROJECT_CONTEXT_TITLE_CLS,
} from "../ui/thread-header-recipes";

const RECENT_THREAD_COUNT = 3;

interface DraftProjectContextProps {
  readonly branch: string | null;
  readonly checkoutLabel: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}

function countThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  matches: (status: ReturnType<typeof resolveSidebarThreadStatus>) => boolean,
) {
  return threads.filter((thread) => matches(resolveSidebarThreadStatus(thread)));
}

function openPullRequestCount(threads: ReadonlyArray<EnvironmentThreadShell>): number {
  return threads.filter((thread) => {
    const pullRequest = resolveRowPullRequest(thread);
    return pullRequest?.state === "open" || pullRequest?.state === "draft";
  }).length;
}

/**
 * The quiet project summary above the new-thread composer: where the draft will run, how many
 * threads need attention and the three threads the user touched last.
 */
export function DraftProjectContext({
  branch,
  checkoutLabel,
  threads,
  onOpenThread,
}: DraftProjectContextProps) {
  const running = countThreads(threads, (status) => status === "working");
  const needsInput = countThreads(threads, (status) => status === "input");
  const needsApproval = countThreads(threads, (status) => status === "approval");
  const openPrs = openPullRequestCount(threads);
  const recent = [...threads]
    .sort(
      (left, right) =>
        Date.parse(threadTimeTimestamp(right)) - Date.parse(threadTimeTimestamp(left)),
    )
    .slice(0, RECENT_THREAD_COUNT);

  const countLink = (
    matches: ReadonlyArray<EnvironmentThreadShell>,
    label: string,
  ): ReactElement | null => {
    const first = matches[0];
    if (first === undefined) return null;
    return (
      <button
        type="button"
        onClick={() => onOpenThread(scopeThreadRef(first.environmentId, first.id))}
        aria-label={`Open ${label}: ${first.title}`}
        className={DRAFT_PROJECT_CONTEXT_LINK_CLS}
      >
        {matches.length} {label}
      </button>
    );
  };

  return (
    <section
      aria-label="Project context"
      data-draft-project-context=""
      className={DRAFT_PROJECT_CONTEXT_CLS}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1">
          {branch === null ? (
            <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
          ) : checkoutLabel === "Local checkout" ? (
            <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
          )}
          {branch !== null ? (
            <Tooltip>
              <TooltipTrigger render={<span className={DRAFT_PROJECT_CONTEXT_BRANCH_CLS} />}>
                {branch}
              </TooltipTrigger>
              <TooltipPopup side="top">{branch}</TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="shrink-0">· {checkoutLabel}</span>
        </span>
        {openPrs > 0 ? (
          <span className="inline-flex items-center gap-1">
            <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 shrink-0" />
            {openPrs} open {openPrs === 1 ? "pull request" : "pull requests"}
          </span>
        ) : null}
      </div>
      {running.length > 0 || needsInput.length > 0 || needsApproval.length > 0 ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {countLink(running, "running")}
          {countLink(needsInput, "needs input")}
          {countLink(needsApproval, "needs approval")}
        </div>
      ) : null}
      {recent.length > 0 ? (
        <ul className={DRAFT_PROJECT_CONTEXT_LIST_CLS}>
          {recent.map((thread) => {
            const threadRef = scopeThreadRef(thread.environmentId, thread.id);
            const status = resolveThreadStatusPill({ thread });
            return (
              <li key={thread.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenThread(threadRef)}
                  aria-label={`Open thread: ${thread.title}`}
                  className={DRAFT_PROJECT_CONTEXT_ROW_CLS}
                >
                  <SidebarThreadStatusGlyph status={status} />
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
