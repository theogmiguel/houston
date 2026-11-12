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
import { ChevronDownIcon, CornerUpLeftIcon, FolderIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
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
import {
  THREAD_HEADER_ROOT_CLS,
  THREAD_PARENT_LINK_CLS,
  THREAD_PARENT_TEXT_CLS,
  THREAD_PROJECT_GROUP_CLS,
  THREAD_PROJECT_ICON_CLS,
  THREAD_PROJECT_ROW_CLS,
  THREAD_PROJECT_SEPARATOR_CLS,
  THREAD_PROJECT_TEXT_CLS,
  THREAD_TITLE_BUTTON_CLS,
  THREAD_TITLE_CHEVRON_CLS,
  THREAD_TITLE_INPUT_CLS,
  THREAD_TITLE_TEXT_CLS,
} from "../ui/thread-header-recipes";
import { ThreadRowPullRequestBadge } from "../grid/ThreadRowPullRequestBadge";
import type { RowPullRequest } from "~/threads/rowPullRequest";
import { textDirection } from "~/textDirection";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  pullRequest: RowPullRequest | null;
  pullRequestCount: number;
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
  pullRequest,
  pullRequestCount,
  onOpenThread,
  onOpenProjectSettings,
  onFindInThread,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.isScratch
    ? "No project"
    : activeProject?.title.trim() || undefined;
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
      {activeProjectName ? (
        <span data-thread-project="" className={THREAD_PROJECT_GROUP_CLS}>
          <Tooltip>
            <TooltipTrigger render={<span className={THREAD_PROJECT_ROW_CLS} />}>
              <FolderIcon aria-hidden className={THREAD_PROJECT_ICON_CLS} />
              <span className={THREAD_PROJECT_TEXT_CLS}>{activeProjectName}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{activeProjectName}</TooltipPopup>
          </Tooltip>
          <span aria-hidden className={THREAD_PROJECT_SEPARATOR_CLS}>
            /
          </span>
        </span>
      ) : null}
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
      {pullRequest !== null ? (
        <ThreadRowPullRequestBadge
          threadRef={activeThreadRef}
          pullRequest={pullRequest}
          pullRequestCount={pullRequestCount}
          onOpenThread={() => {}}
        />
      ) : null}
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
      {parentThreadLink !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open parent thread: ${parentThreadLink.title}`}
                onClick={() => onOpenThread(parentThreadLink.threadId)}
                className={THREAD_PARENT_LINK_CLS}
              />
            }
          >
            <CornerUpLeftIcon aria-hidden className="size-3 shrink-0" />
            <span className={THREAD_PARENT_TEXT_CLS}>{parentThreadLink.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
        </Tooltip>
      ) : null}
      <TaskThreadLink environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
    </div>
  );
});
