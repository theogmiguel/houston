import { formatDiffCount } from "@houston-app/client-runtime/diff-count";
import {
  ROW_DIFF_ADDED_CLS,
  ROW_DIFF_COUNTS_CLS,
  ROW_DIFF_REMOVED_CLS,
  ROW_DRAFT_CROSS_CLS,
  ROW_DRAFT_MARK_CLS,
  ROW_DRAFT_PENCIL_CLS,
} from "../ui/sidebar-rail-recipes";
import { scopeProjectRef, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { FolderGit2Icon, GitBranchIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useEffect, type RefObject } from "react";

import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import { formatGridDiffCounts } from "../../grid/sidebar";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { cn } from "../../lib/utils";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { vcsEnvironment } from "../../state/vcs";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSidebarRowSubscriptionLease } from "../Sidebar.logic";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The checkout's uncommitted line totals. The status subscription is held only
 * while the row is on screen or close to it, so a long rail does not keep one
 * live query per thread.
 */
export function useThreadDiffTotals(
  thread: EnvironmentThreadShell,
  rowRef: RefObject<HTMLElement | null>,
  active: boolean,
): { insertions: number; deletions: number } | null {
  const { leaseLiveStatus, rowRef: observeRow } = useSidebarRowSubscriptionLease(active);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- attaches the viewport observer that leases the live status to the mounted row
  useEffect(() => {
    const row = rowRef.current;
    return row === null ? undefined : observeRow(row);
  });
  const project = useProject(
    thread.worktreePath === null ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
  const status = useEnvironmentQuery(
    leaseLiveStatus && cwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd, includeRemote: false },
        })
      : null,
  );
  const totals = status.data?.workingTree;
  if (totals === undefined || (totals.insertions === 0 && totals.deletions === 0)) return null;
  return { insertions: totals.insertions, deletions: totals.deletions };
}

/** A worktree thread shows the worktree mark; every other thread shows the plain branch mark. */
export function ThreadCheckoutMark({
  thread,
}: {
  thread: Pick<EnvironmentThreadShell, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return (
      <span role="img" aria-label="Local checkout" className="inline-flex shrink-0">
        <GitBranchIcon aria-hidden className="size-3" />
      </span>
    );
  }
  const label = `Worktree: ${formatWorktreePathForDisplay(worktreePath)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-thread-worktree=""
            className="inline-flex shrink-0"
          />
        }
      >
        <FolderGit2Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RemoteMachineMark({ thread }: { thread: EnvironmentThreadShell }) {
  const machines = useEnvironmentMachines();
  return (
    <span
      role="img"
      aria-label="Runs on another machine"
      data-thread-remote=""
      className="inline-flex shrink-0 items-center"
    >
      <EnvironmentMachineIcon
        aria-hidden
        kind={machines.get(thread.environmentId) ?? "server"}
        className="size-3"
      />
    </span>
  );
}

/**
 * Indicators for what is going on around a thread: a running terminal, an
 * unsent draft, uncommitted changes and a remote environment.
 */
export function ThreadRowIndicators({
  thread,
  rowRef,
  focused,
  onActivate,
}: {
  thread: EnvironmentThreadShell;
  rowRef: RefObject<HTMLElement | null>;
  focused: boolean;
  /** Opens the thread, where a terminal indicator reveals its terminal. */
  onActivate: () => void;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const terminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const hasDraft = useThreadHasUnsentDraft(threadRef) && !focused;
  const diff = useThreadDiffTotals(thread, rowRef, focused);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remote = primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  if (terminalIds.length === 0 && !hasDraft && diff === null && !remote) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-thread-indicators="">
      <ThreadTerminalStatusButton
        threadRef={threadRef}
        terminalIds={terminalIds}
        onThreadActivate={onActivate}
      />
      {hasDraft ? <DraftMark threadRef={threadRef} title={thread.title} /> : null}
      {diff === null ? null : (
        <span
          role="img"
          aria-label={`Uncommitted changes ${formatGridDiffCounts(diff)}`}
          className={`shrink-0 ${ROW_DIFF_COUNTS_CLS}`}
        >
          <span className={ROW_DIFF_ADDED_CLS}>+{formatDiffCount(diff.insertions)}</span>{" "}
          <span className={ROW_DIFF_REMOVED_CLS}>−{formatDiffCount(diff.deletions)}</span>
        </span>
      )}
      {remote ? <RemoteMachineMark thread={thread} /> : null}
    </span>
  );
}

/** The unsent-draft pen; hovering or focusing it turns it into the Discard draft action. */
function DraftMark({
  threadRef,
  title,
}: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  title: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Discard draft in ${title}`}
            data-thread-draft=""
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              discardComposerDraft(threadRef);
            }}
            className={cn(
              "inline-grid size-3.5 shrink-0 place-items-center rounded-(--r-badge)",
              ROW_DRAFT_MARK_CLS,
            )}
          />
        }
      >
        <SquarePenIcon
          aria-hidden
          className={`col-start-1 row-start-1 size-3 ${ROW_DRAFT_PENCIL_CLS}`}
        />
        <XIcon aria-hidden className={`col-start-1 row-start-1 size-3 ${ROW_DRAFT_CROSS_CLS}`} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft. Click to discard</TooltipPopup>
    </Tooltip>
  );
}
