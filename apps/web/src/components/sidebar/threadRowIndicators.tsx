import {
  ROW_DRAFT_CROSS_CLS,
  ROW_DRAFT_MARK_CLS,
  ROW_DRAFT_PENCIL_CLS,
} from "../ui/sidebar-rail-recipes";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { FolderGit2Icon, GitBranchIcon, SquarePenIcon, XIcon } from "lucide-react";

import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { cn } from "../../lib/utils";
import { useT } from "~/i18n/useT";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { RowMetaItem } from "../ui/sidebar-row-meta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A worktree thread shows the worktree mark; every other thread shows the plain branch mark. */
export function ThreadCheckoutMark({
  thread,
}: {
  thread: Pick<EnvironmentThreadShell, "id" | "branch" | "worktreePath">;
}) {
  const t = useT();
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return (
      <span role="img" aria-label={t("Local checkout")} className="inline-flex shrink-0">
        <GitBranchIcon aria-hidden className="size-3.5" />
      </span>
    );
  }
  const label = t("Worktree: {path}", { path: formatWorktreePathForDisplay(worktreePath) });
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
  const t = useT();
  const machines = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (primaryEnvironmentId === null || thread.environmentId === primaryEnvironmentId) return null;
  return (
    <RowMetaItem label={t("Runs on another machine")}>
      <span
        role="img"
        aria-label={t("Runs on another machine")}
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
  const t = useT();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const hasDraft = useThreadHasUnsentDraft(threadRef) && !focused;
  if (!hasDraft) return null;
  return (
    <RowMetaItem label={t("Unsent draft")}>
      <DraftMark threadRef={threadRef} title={thread.title} />
    </RowMetaItem>
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
  const t = useT();
  const terminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  if (terminalIds.length === 0) return null;
  return (
    <RowMetaItem label={terminalIds.length === 1 ? t("Terminal running") : t("Terminals running")}>
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
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("Discard draft in {title}", { title })}
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
