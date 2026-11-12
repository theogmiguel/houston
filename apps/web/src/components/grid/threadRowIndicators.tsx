import { formatDiffCount } from "@houston-app/client-runtime/diff-count";
import {
  ROW_DIFF_COUNTS_CLS,
  rowDiffAddedCls,
  rowDiffRemovedCls,
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
import { RowMetaItem } from "../ui/sidebar-row-meta";
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
        <GitBranchIcon aria-hidden className="size-3.5" />
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
        <FolderGit2Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The machine icon of a thread that runs on another machine; nothing for a local thread. */
export function ThreadRemoteItem({ thread }: { thread: EnvironmentThreadShell }) {
  const machines = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (primaryEnvironmentId === null || thread.environmentId === primaryEnvironmentId) return null;
  return (
    <RowMetaItem label="Runs on another machine">
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
    </RowMetaItem>
  );
}

/** The unsent-draft mark of a row, right after its status word; absent while the thread is open. */
export function ThreadDraftItem({
  thread,
  focused,
}: {
  thread: EnvironmentThreadShell;
  focused: boolean;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const hasDraft = useThreadHasUnsentDraft(threadRef) && !focused;
  if (!hasDraft) return null;
  return (
    <RowMetaItem label="Unsent draft">
      <DraftMark threadRef={threadRef} title={thread.title} />
    </RowMetaItem>
  );
}

/** The checkout's uncommitted line totals, in the muted ink until the row is hovered or open. */
export function ThreadDiffCounts({
  thread,
  rowRef,
  focused,
  emphasized,
}: {
  thread: EnvironmentThreadShell;
  rowRef: RefObject<HTMLElement | null>;
  focused: boolean;
  /** The row is the open or a selected thread: its diff totals show their colours at rest. */
  emphasized: boolean;
}) {
  const diff = useThreadDiffTotals(thread, rowRef, focused);
  if (diff === null) return null;
  return (
    <span
      role="img"
      aria-label={`Uncommitted changes ${formatGridDiffCounts(diff)}`}
      data-thread-diff=""
      className={`shrink-0 ${ROW_DIFF_COUNTS_CLS}`}
    >
      <span className={rowDiffAddedCls(emphasized)}>+{formatDiffCount(diff.insertions)}</span>{" "}
      <span className={rowDiffRemovedCls(emphasized)}>−{formatDiffCount(diff.deletions)}</span>
    </span>
  );
}

/** The running-terminal button of a row; absent while the thread has no running terminal. */
export function ThreadTerminalItem({
  thread,
  onActivate,
}: {
  thread: EnvironmentThreadShell;
  /** Opens the thread, where the button reveals its terminal. */
  onActivate: () => void;
}) {
  const terminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  if (terminalIds.length === 0) return null;
  return (
    <RowMetaItem label={terminalIds.length === 1 ? "Terminal running" : "Terminals running"}>
      <ThreadTerminalStatusButton
        threadRef={scopeThreadRef(thread.environmentId, thread.id)}
        terminalIds={terminalIds}
        onThreadActivate={onActivate}
      />
    </RowMetaItem>
  );
}

/** The unsent-draft pen and word; hovering or focusing it turns the pen into the Discard draft action. */
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
              "inline-flex shrink-0 items-center gap-1 rounded-(--r-badge)",
              ROW_DRAFT_MARK_CLS,
            )}
          />
        }
      >
        <span className="inline-grid size-3.5 place-items-center">
          <SquarePenIcon
            aria-hidden
            className={`col-start-1 row-start-1 size-3 ${ROW_DRAFT_PENCIL_CLS}`}
          />
          <XIcon aria-hidden className={`col-start-1 row-start-1 size-3 ${ROW_DRAFT_CROSS_CLS}`} />
        </span>
        <span>Draft</span>
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft. Click to discard</TooltipPopup>
    </Tooltip>
  );
}
