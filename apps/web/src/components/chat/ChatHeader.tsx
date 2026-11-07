import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CornerUpLeftIcon,
  FolderGit2Icon,
  GitBranchIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick, type ThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { TaskThreadLink } from "../tasks/TaskThreadLink";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { SidebarStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { threadStateTextClass } from "../ui/thread-state-glyph";
import {
  THREAD_HEADER_ROOT_CLS,
  THREAD_META_BRANCH_CLS,
  THREAD_META_CARET_CLS,
  THREAD_META_DIFF_BUTTON_CLS,
  THREAD_META_DIVIDER_CLS,
  THREAD_META_LINK_CLS,
  THREAD_META_MODEL_CLS,
  THREAD_META_MODEL_GROUP_CLS,
  THREAD_META_MODEL_NAME_CLS,
  THREAD_META_PROJECT_CLS,
  THREAD_META_ROW_CLS,
  THREAD_META_STATUS_CLS,
  THREAD_TITLE_BUTTON_CLS,
  THREAD_TITLE_CHEVRON_CLS,
  THREAD_TITLE_GROUP_CLS,
  THREAD_TITLE_INPUT_CLS,
  THREAD_TITLE_ROW_CLS,
  THREAD_TITLE_TEXT_CLS,
} from "../ui/thread-header-recipes";
import { ThreadRowPullRequestBadge } from "../grid/ThreadRowPullRequestBadge";
import type { RowPullRequest } from "~/grid/sidebar";
import { textDirection } from "~/textDirection";

/** Facts the thread header states beside the title. Absent values stay unrendered. */
export interface ChatHeaderMeta {
  readonly branch: string | null;
  readonly checkoutLabel: string;
  readonly status: ThreadStatusPill | null;
  readonly pullRequest: RowPullRequest | null;
  readonly pullRequestCount: number;
  readonly diffTotals: { insertions: number; deletions: number } | null;
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly onOpenChanges?: (() => void) | undefined;
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  meta?: ChatHeaderMeta | undefined;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  parentThreadLink,
  meta,
  onOpenThread,
  onOpenProjectSettings,
  onFindInThread,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const handleNewThread = useNewThreadHandler();
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    onStartRename: startRename,
    onFind: onFindInThread,
    handleNewThread,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.hostBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  return (
    <div className={THREAD_HEADER_ROOT_CLS} onContextMenu={handleHeaderContextMenu}>
      <div className={THREAD_TITLE_ROW_CLS}>
        <div className={THREAD_TITLE_GROUP_CLS}>
          {renamingTitle !== null ? (
            <input
              autoFocus
              dir="auto"
              aria-label="Thread title"
              className={THREAD_TITLE_INPUT_CLS}
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                    onBlur={cancelPendingTitleMenu}
                    className={THREAD_TITLE_BUTTON_CLS}
                  />
                }
              >
                <h2
                  aria-label={activeThreadTitle}
                  className={THREAD_TITLE_TEXT_CLS}
                  dir={textDirection(activeThreadTitle)}
                >
                  {activeThreadTitle}
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className={THREAD_TITLE_CHEVRON_CLS}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2
                    aria-label={activeThreadTitle}
                    className={THREAD_TITLE_TEXT_CLS}
                    dir={textDirection(activeThreadTitle)}
                  />
                }
              >
                {activeThreadTitle}
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
          {renamingTitle === null && activeThreadLinkOrigin ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="info" size="sm" />}>
                From {activeThreadLinkOrigin}
              </TooltipTrigger>
              <TooltipPopup side="top">
                Started by an agent on {activeThreadLinkOrigin} through a linked environment.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <TaskThreadLink environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
      </div>
      <ThreadHeaderMeta
        activeProjectName={activeProjectName ?? null}
        meta={meta}
        parentThreadLink={parentThreadLink}
        threadRef={activeThreadRef}
        onOpenThread={onOpenThread}
      />
    </div>
  );
});

function ThreadHeaderMeta({
  activeProjectName,
  meta,
  parentThreadLink,
  threadRef,
  onOpenThread,
}: {
  readonly activeProjectName: string | null;
  readonly meta: ChatHeaderMeta | undefined;
  readonly parentThreadLink: { threadId: ThreadId; title: string } | null;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  if (meta === undefined) return null;
  const { branch, status, pullRequest, diffTotals, providerLabel, modelLabel } = meta;
  const showDiff =
    diffTotals !== null &&
    hasNonZeroStat({ additions: diffTotals.insertions, deletions: diffTotals.deletions });
  return (
    <div data-thread-header-meta="" className={THREAD_META_ROW_CLS}>
      {activeProjectName ? (
        <Tooltip>
          <TooltipTrigger render={<span className={THREAD_META_PROJECT_CLS} />}>
            {activeProjectName}
          </TooltipTrigger>
          <TooltipPopup side="top">{activeProjectName}</TooltipPopup>
        </Tooltip>
      ) : null}
      {activeProjectName && (branch !== null || meta.checkoutLabel.length > 0) ? (
        <ChevronRightIcon aria-hidden className={THREAD_META_CARET_CLS} />
      ) : null}
      {parentThreadLink !== null ? (
        <>
          <MetaDivider />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Open parent thread: ${parentThreadLink.title}`}
                  onClick={() => onOpenThread(parentThreadLink.threadId)}
                  className={THREAD_META_LINK_CLS}
                />
              }
            >
              <CornerUpLeftIcon aria-hidden className="size-3 shrink-0" />
              <span className="max-w-40 min-w-0 truncate">{parentThreadLink.title}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      {branch !== null || meta.checkoutLabel.length > 0 ? (
        <span className={THREAD_META_STATUS_CLS}>
          {branch === null ? (
            <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
          ) : meta.checkoutLabel === "Local checkout" ? (
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          ) : (
            <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
          )}
          {branch !== null ? (
            <Tooltip>
              <TooltipTrigger render={<span className={THREAD_META_BRANCH_CLS} />}>
                {branch}
              </TooltipTrigger>
              <TooltipPopup side="top">{branch}</TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="shrink-0">{meta.checkoutLabel}</span>
        </span>
      ) : null}
      {status !== null ? (
        <>
          <MetaDivider />
          <span className={THREAD_META_STATUS_CLS}>
            <SidebarStatusGlyph state={status.state} label={status.label} />
            <span className={threadStateTextClass(status.state)}>{status.label}</span>
          </span>
        </>
      ) : null}
      {pullRequest !== null ? (
        <>
          <MetaDivider />
          <ThreadRowPullRequestBadge
            threadRef={threadRef}
            pullRequest={pullRequest}
            pullRequestCount={meta.pullRequestCount}
            onOpenThread={() => {}}
          />
        </>
      ) : null}
      {showDiff ? (
        <>
          <MetaDivider />
          <button
            type="button"
            onClick={meta.onOpenChanges}
            aria-label={`Open changes: ${diffTotals.insertions} additions, ${diffTotals.deletions} deletions`}
            className={THREAD_META_DIFF_BUTTON_CLS}
          >
            <DiffStatLabel
              additions={diffTotals.insertions}
              deletions={diffTotals.deletions}
              layout="inline"
            />
          </button>
        </>
      ) : null}
      {providerLabel !== null || modelLabel !== null ? (
        <span className={THREAD_META_MODEL_GROUP_CLS}>
          <MetaDivider />
          <span className={THREAD_META_MODEL_CLS}>
            {providerLabel !== null ? <span className="shrink-0">{providerLabel}</span> : null}
            {providerLabel !== null && modelLabel !== null ? <span aria-hidden>·</span> : null}
            {modelLabel !== null ? (
              <Tooltip>
                <TooltipTrigger render={<span className={THREAD_META_MODEL_NAME_CLS} />}>
                  {modelLabel}
                </TooltipTrigger>
                <TooltipPopup side="top">{modelLabel}</TooltipPopup>
              </Tooltip>
            ) : null}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function MetaDivider() {
  return (
    <span aria-hidden className={THREAD_META_DIVIDER_CLS}>
      ·
    </span>
  );
}
