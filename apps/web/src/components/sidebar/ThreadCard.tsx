import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { canSnooze } from "@houston-app/client-runtime/state/thread-settled";
import { useLocation } from "@tanstack/react-router";
import {
  AlarmClockOffIcon,
  ClockIcon,
  FolderIcon,
  MoreHorizontalIcon,
  Undo2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  useContext,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  useThreadActionMenu,
  type ThreadActionMenuWorkspaceInput,
} from "../../hooks/useThreadActionMenu";
import type { NewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { resolveThreadRowState } from "../../threads/sidebarModel";
import { sweepActionProps } from "../../threads/rowActionSweep";
import { beginThreadDrag, useThreadDropZone, type ThreadDragSource } from "../../threads/threadDrag";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { resolveRowPullRequest } from "../../threads/rowPullRequest";
import { isThreadRoutePathname } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { SidebarProviderStack, type SidebarProviderEntry } from "./SidebarThreadRow";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { MOTION_FEEDBACK, MOTION_FEEDBACK_OPACITY } from "../ui/motion-recipes";
import { RowMeta, RowMetaItem } from "../ui/sidebar-row-meta";
import {
  FOCUS_ACTION_CLS,
  FOCUS_ROW_CLS,
  ROW_ACTIONS_REVEAL,
  ROW_ACTIONS_VISIBLE,
  ROW_STATUS_HIDDEN,
  ROW_STATUS_RECEDE,
} from "../ui/sidebar";
import {
  SIDEBAR_MENU_HEADING_CLS,
  SIDEBAR_MENU_HINT_CLS,
  SIDEBAR_PROJECT_ICON_BOX_CLS,
  SIDEBAR_SEARCH_MARK_CLS,
  SIDEBAR_SR_ONLY_CLS,
  SIDEBAR_TABULAR_CLS,
  SIDEBAR_THREAD_ICON_ACTION_CLS,
  SIDEBAR_THREAD_PROJECT_CLS,
  SIDEBAR_THREAD_ROW_INDENT_CLS,
  SIDEBAR_THREAD_TEXT_ACTION_CLS,
  SIDEBAR_THREAD_TITLE_BUTTON_CLS,
  SIDEBAR_THREAD_TITLE_REGENERATING_CLS,
  sidebarThreadRowCls,
} from "../ui/sidebar-sections";
import { ROW_SCROLL_MARGIN_CLS, ROW_TITLE_TEXT_CLS } from "../ui/sidebar-rail-recipes";
import { SIDEBAR_THREAD_META_TEXT_CLASS, SIDEBAR_THREAD_TAG_CLASS } from "../ui/thread-tag-recipes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RowActionSweepContext } from "./rowActionSweepContext";
import { useSearchHighlight } from "./sidebarSearchResults";
import { ThreadHoverCard } from "./threadHoverCard";
import { JumpHintBadge, useThreadJumpHint } from "./threadJumpHints";
import { ThreadRowPullRequestBadge } from "./ThreadRowPullRequestBadge";
import { threadHasStatus, ThreadStatusWord } from "./threadStatusMark";
import { ThreadTitleInput } from "./threadTitleInput";
import {
  ThreadCheckoutMark,
  ThreadDiffCounts,
  ThreadDraftItem,
  ThreadRemoteItem,
  ThreadTerminalItem,
} from "./threadRowIndicators";
import { ThreadBulkMenuContext } from "./useBulkThreadMenu";
import { useThreadProjectFilter } from "./ProjectFilterPicker";
import { useRowFileDrop } from "./useRowFileDrop";

const AGO_SUFFIX_RE = / ago$/;

function threadTimeLabel(thread: EnvironmentThreadShell, nowMinute: string): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`)).replace(
    AGO_SUFFIX_RE,
    "",
  );
}

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (needle.length === 0) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (;;) {
    const index = lower.indexOf(target, cursor);
    if (index === -1) break;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`${index}-${target}`} className={SIDEBAR_SEARCH_MARK_CLS}>
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** The narrowest a branch name gets before the line drops items: mark, a few characters, an ellipsis. */
const BRANCH_MIN_WIDTH_PX = 56;

/** Branch names every checkout is assumed to treat as the project's default. */
const CONVENTIONAL_DEFAULT_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

/** The branch a thread recorded, else the one its checkout (worktree or project folder) has now. */
function useThreadBranch(thread: EnvironmentThreadShell): {
  name: string | null;
  isDefault: boolean;
} {
  const readsCheckout = thread.branch === null;
  const project = useProject(
    readsCheckout && thread.worktreePath === null
      ? scopeProjectRef(thread.environmentId, thread.projectId)
      : null,
  );
  const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
  const status = useEnvironmentQuery(
    readsCheckout && cwd !== null
      ? vcsEnvironment.status({ environmentId: thread.environmentId, input: { cwd } })
      : null,
  );
  const name = thread.branch ?? status.data?.refName ?? null;
  const conventional = name !== null && CONVENTIONAL_DEFAULT_BRANCHES.has(name);
  return {
    name,
    isDefault: thread.branch === null ? (status.data?.isDefaultRef ?? conventional) : conventional,
  };
}

// Positioned so the actions paint above the faded time; out of flow until the row is hovered or focused.
const ROW_ACTIONS_IN_FLOW = "relative";
const ROW_ACTIONS_OUT_OF_FLOW =
  "absolute top-0 right-0 group-hover/th:relative group-has-[:focus-visible]/th:relative";

/**
 * A thread row, three lines: the project and the status at the right; the title on the full
 * width; the branch, then the pull request, diff counts and provider at the right.
 */
export function ThreadCard({
  workspaceId,
  thread,
  query,
  providerEntries,
  nowIso,
  focused,
  selected,
  dragging,
  projectTitle,
  timeLabel = null,
  shelf = null,
  runningSubagents = 0,
  treeParent,
  onOpen,
  onSelect,
  onClose,
  onHold,
  onPickHoldTime,
  onRename,
  onSetAutoClose,
  onWake,
  onReopen,
  onDropOnThread,
  workspaceMove,
  handleNewThread,
}: {
  /** The workspace whose group draws the row; null for a row outside any (Needs you, a shelf). */
  workspaceId: string | null;
  thread: EnvironmentThreadShell;
  query: string;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  focused: boolean;
  selected: boolean;
  dragging: boolean;
  /** The project's name, on the row's first line. */
  projectTitle: string;
  timeLabel?: string | null;
  shelf?: "snoozed" | "settled" | null;
  runningSubagents?: number;
  /** The row id of the workspace this row sits under, for arrow-key navigation. */
  treeParent?: string | undefined;
  onOpen: () => void;
  onSelect: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onClose: () => void;
  onHold: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onRename: (title: string) => void;
  onSetAutoClose: (enabled: boolean) => void;
  onWake?: () => void;
  onReopen?: () => void;
  onDropOnThread: (source: ThreadDragSource) => void;
  /** Lists the other workspaces in the thread menu; absent hides Move to workspace. */
  workspaceMove?: ThreadActionMenuWorkspaceInput | undefined;
  /** Supplies New thread on branch; absent hides that item. */
  handleNewThread?: NewThreadHandler | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [actionsHovered, setActionsHovered] = useState(false);
  const [holdMenuOpen, setHoldMenuOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const nowMinute = useNowMinute();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const showBranch = useClientSettings((settings) => settings.sidebarRowShowBranch);
  const { name: branchName } = useThreadBranch(thread);
  const showPullRequest = useClientSettings((settings) => settings.sidebarRowShowPullRequest);
  const showSubagents = useClientSettings((settings) => settings.sidebarRowShowSubagents);
  const state = resolveThreadRowState(thread, nowIso);
  // The open thread: its chat is the focused tab, or its own route is showing.
  const routeActive = useLocation({
    select: (location) =>
      isThreadRoutePathname(location.pathname, scopeThreadRef(thread.environmentId, thread.id)),
  });
  const active = focused || routeActive;
  const rowPullRequest = resolveRowPullRequest(thread);
  const providerEntry = providerEntries.get(thread.providerInstanceId);
  const presets = resolveSnoozePresets(
    new Date(`${nowMinute}:00.000Z`),
    timestampFormat,
    thread.environmentId,
  );
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const searchHighlight = useSearchHighlight(threadKey);
  const fileDrop = useRowFileDrop(thread);
  const jumpHint = useThreadJumpHint(threadKey);
  const bulkMenu = useContext(ThreadBulkMenuContext);
  const sweep = useContext(RowActionSweepContext);
  const regeneratingTitle = thread.titleRegeneration != null;
  const canHold = canSnooze(thread, { now: nowIso });
  const actionsVisible = actionsHovered || holdMenuOpen || actionsMenuOpen;
  const [previewOpen, setPreviewOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const startRename = () => setRenaming(true);
  const timeNode = (
    <span data-thread-time="" className={cn(SIDEBAR_TABULAR_CLS, SIDEBAR_THREAD_META_TEXT_CLASS)}>
      {timeLabel ?? threadTimeLabel(thread, nowMinute)}
    </span>
  );
  const openCardMenu = async (position: { x: number; y: number }) => {
    setActionsMenuOpen(true);
    await openMenu(position).finally(() => setActionsMenuOpen(false));
  };
  const openCardMenuFromButton = () => {
    const rect = actionsButtonRef.current?.getBoundingClientRect();
    if (rect === undefined || rect === null) return;
    void openCardMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  // A selected row in a multi-selection opens the menu for the whole selection.
  const openRowMenu = (position: { x: number; y: number }) => {
    if (selected && bulkMenu !== null) bulkMenu(position);
    else void openCardMenu(position);
  };
  const openCardMenuFromRow = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect === undefined || rect === null) return;
    openRowMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const projectFilter = useThreadProjectFilter({
    environmentId: thread.environmentId,
    projectId: thread.projectId,
  });
  const { openMenu } = useThreadActionMenu({
    threadRef,
    thread,
    projectFilter,
    onStartRename: startRename,
    handleNewThread,
    workspace: workspaceMove,
    onCloseThread: onClose,
    onHoldThread: (snoozedUntil) => onHold({ snoozedUntil }),
    onSetAutoSettle: onSetAutoClose,
    onReopenThread: onReopen,
    onWakeThread: onWake,
  });

  const applyPreset = (preset: Pick<SnoozePreset, "snoozedUntil"> | undefined) => {
    if (preset !== undefined) onHold(preset);
  };

  // Hidden, not disabled, while the actions are in use: a disabled tooltip ignores the pointer
  // leaving the row, so a hover open still pending would land after the pointer was gone.
  const previewSuppressed = actionsHovered || holdMenuOpen || actionsMenuOpen;

  const startRowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (renaming) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("input, textarea, [contenteditable='true']") !== null) return;
      // The title button starts the drag; the row's other controls keep their click.
      const control = target.closest("button, a, [role='button']");
      if (control !== null && !control.hasAttribute("data-card-open")) return;
    }
    beginThreadDrag(event, {
      workspaceId,
      threadId: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      title: thread.title,
    });
  };
  useThreadDropZone(
    rowRef,
    (_point, source) =>
      shelf === null && workspaceId !== null && source.threadId !== thread.id
        ? { kind: "workspace", workspaceId }
        : null,
    (source) => onDropOnThread(source),
  );

  const statusShown = shelf === null && (threadHasStatus(thread, state) || state === "back");
  const backShown = statusShown && state === "back";

  const rowCls = cn(
    sidebarThreadRowCls({
      dragging,
      fileDropOver: fileDrop.over,
      selected,
      highlighted: searchHighlight.highlighted,
      active,
    }),
    MOTION_FEEDBACK,
    FOCUS_ROW_CLS,
    SIDEBAR_THREAD_ROW_INDENT_CLS,
    ROW_SCROLL_MARGIN_CLS,
  );
  return (
    <Tooltip open={previewOpen && !previewSuppressed} onOpenChange={setPreviewOpen}>
      <TooltipTrigger
        render={
          <div
            ref={(element) => {
              rowRef.current = element;
              searchHighlight.attach(element);
            }}
            data-search-highlighted={searchHighlight.highlighted || undefined}
            data-file-drop-over={fileDrop.over || undefined}
            {...fileDrop.handlers}
            onPointerDown={startRowDrag}
            tabIndex={-1}
            data-thread-key={threadKey}
            data-sidebar-row={threadKey}
            data-sidebar-parent={treeParent}
            data-thread-current={active ? "" : undefined}
            aria-busy={regeneratingTitle || undefined}
            onContextMenu={(event) => {
              if (renaming) return;
              event.preventDefault();
              openRowMenu({ x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                openCardMenuFromRow();
                return;
              }
              // The row's own keys; its buttons keep theirs.
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (shelf === null && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                  onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                } else {
                  onOpen();
                }
              } else if (event.key === "F2") {
                event.preventDefault();
                startRename();
              }
            }}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("button, input, [role='button'], [role='menu']") !== null
              ) {
                return;
              }
              if (shelf === null && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                return;
              }
              onOpen();
            }}
            className={rowCls}
          />
        }
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div data-thread-project-line="" className="flex h-4 min-w-0 items-center gap-2">
            <span
              data-thread-project=""
              className={cn(
                "flex min-w-0 flex-1 items-center gap-1.5",
                SIDEBAR_THREAD_META_TEXT_CLASS,
              )}
            >
              <span aria-hidden className={SIDEBAR_PROJECT_ICON_BOX_CLS}>
                <FolderIcon className="size-3" />
              </span>
              <span className={SIDEBAR_THREAD_PROJECT_CLS}>{projectTitle}</span>
            </span>
            {/* Back is a button: it stays beside the swapped cell, never under the hover actions. */}
            {backShown ? (
              <span className="ml-auto flex shrink-0 items-center">
                <ThreadStatusWord thread={thread} state={state} nowIso={nowIso} />
              </span>
            ) : null}
            {/* Status (or age) and hover actions share one cell; hidden actions leave the flow. */}
            <span
              className={cn(
                "relative grid h-4 shrink-0 grid-rows-1 items-center justify-items-end",
                backShown ? "ml-1" : "ml-auto",
              )}
            >
              <span
                className={cn(
                  "col-start-1 row-start-1 flex min-w-7 items-center justify-end",
                  ROW_STATUS_RECEDE,
                  MOTION_FEEDBACK_OPACITY,
                  actionsVisible && ROW_STATUS_HIDDEN,
                )}
              >
                {jumpHint !== null ? (
                  <JumpHintBadge label={jumpHint} />
                ) : shelf !== null || backShown ? null : statusShown ? (
                  <ThreadStatusWord thread={thread} state={state} nowIso={nowIso} />
                ) : (
                  timeNode
                )}
              </span>
              <span
                className={cn(
                  "col-start-1 row-start-1 flex h-5 items-center gap-0.5",
                  MOTION_FEEDBACK_OPACITY,
                  actionsVisible ? ROW_ACTIONS_IN_FLOW : ROW_ACTIONS_OUT_OF_FLOW,
                  actionsVisible ? ROW_ACTIONS_VISIBLE : ROW_ACTIONS_REVEAL,
                )}
                onMouseEnter={() => setActionsHovered(true)}
                onMouseLeave={() => setActionsHovered(false)}
              >
                {shelf !== null ? (
                  <button
                    type="button"
                    aria-label={shelf === "snoozed" ? "Wake thread now" : "Reopen thread"}
                    {...sweepActionProps(shelf === "snoozed" ? "wake" : "reopen")}
                    onPointerDown={(event) =>
                      sweep?.(event, shelf === "snoozed" ? "wake" : "reopen", threadKey)
                    }
                    onClick={shelf === "snoozed" ? onWake : onReopen}
                    className={cn(SIDEBAR_THREAD_TEXT_ACTION_CLS, FOCUS_ACTION_CLS)}
                  >
                    {shelf === "snoozed" ? (
                      <>
                        <AlarmClockOffIcon aria-hidden className="size-3.5" />
                        Wake
                      </>
                    ) : (
                      <>
                        <Undo2Icon aria-hidden className="size-3.5" />
                        Reopen
                      </>
                    )}
                  </button>
                ) : (
                  <>
                    {canHold ? (
                      <Menu onOpenChange={setHoldMenuOpen}>
                        <MenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Hold"
                              className={cn(SIDEBAR_THREAD_ICON_ACTION_CLS, FOCUS_ACTION_CLS)}
                            >
                              <ClockIcon aria-hidden className="size-3.5" />
                            </button>
                          }
                        />
                        <MenuPopup side="bottom" align="end">
                          <HoldMenuItems
                            presets={presets}
                            onPick={applyPreset}
                            onPickTime={onPickHoldTime}
                          />
                        </MenuPopup>
                      </Menu>
                    ) : null}
                    <button
                      type="button"
                      aria-label="Close thread"
                      {...sweepActionProps("close")}
                      onPointerDown={(event) => sweep?.(event, "close", threadKey)}
                      onClick={onClose}
                      className={cn(SIDEBAR_THREAD_TEXT_ACTION_CLS, FOCUS_ACTION_CLS)}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                      Close
                    </button>
                    <button
                      ref={actionsButtonRef}
                      type="button"
                      aria-label={`Thread actions for ${thread.title}`}
                      aria-haspopup="menu"
                      onClick={openCardMenuFromButton}
                      className={cn(SIDEBAR_THREAD_ICON_ACTION_CLS, FOCUS_ACTION_CLS)}
                    >
                      <MoreHorizontalIcon aria-hidden className="size-3.5" />
                    </button>
                  </>
                )}
              </span>
            </span>
          </div>
          <div data-thread-title-line="" className="flex h-5 min-w-0 items-center">
            {renaming ? (
              <ThreadTitleInput
                title={thread.title}
                onCommit={(next) => {
                  setRenaming(false);
                  onRename(next);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <button
                type="button"
                data-card-open=""
                onClick={(event) => {
                  if (shelf === null && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    onSelect({
                      shiftKey: event.shiftKey,
                      toggleKey: event.metaKey || event.ctrlKey,
                    });
                    return;
                  }
                  // The second click of a double-click renames; it must not open the thread again.
                  if (isTrailingDoubleClick(event.detail)) return;
                  onOpen();
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  startRename();
                }}
                onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
                  if (event.key === "F2") {
                    event.preventDefault();
                    startRename();
                  }
                }}
                aria-current={active ? "true" : undefined}
                className={SIDEBAR_THREAD_TITLE_BUTTON_CLS}
              >
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    ROW_TITLE_TEXT_CLS,
                    regeneratingTitle && SIDEBAR_THREAD_TITLE_REGENERATING_CLS,
                  )}
                >
                  <HighlightedText text={thread.title} query={query} />
                </span>
              </button>
            )}
          </div>
          {/* Items that do not fit beside the branch drop whole behind +N; the right group stays. */}
          <div
            data-thread-meta=""
            className={cn("flex h-4 min-w-0 items-center gap-2", SIDEBAR_THREAD_META_TEXT_CLASS)}
          >
            <RowMeta>
              {/* A shelf row's label ("tomorrow at 9:00 AM", "Closed 2h") has no status cell to sit in. */}
              {shelf !== null && jumpHint === null ? (
                <RowMetaItem label="Time" keep>
                  {timeNode}
                </RowMetaItem>
              ) : null}
              {showBranch && branchName !== null ? (
                <RowMetaItem label={`Branch ${branchName}`} minWidth={BRANCH_MIN_WIDTH_PX}>
                  <span data-thread-branch="" className="inline-flex min-w-0 items-center gap-1">
                    <ThreadCheckoutMark thread={thread} />
                    <span className="min-w-0 truncate">{branchName}</span>
                  </span>
                </RowMetaItem>
              ) : showBranch && thread.worktreePath?.trim() ? (
                <RowMetaItem label="Worktree">
                  <ThreadCheckoutMark thread={thread} />
                </RowMetaItem>
              ) : null}
              <ThreadDraftItem thread={thread} focused={focused} />
              <ThreadTerminalItem thread={thread} onActivate={onOpen} />
              <ThreadRemoteItem thread={thread} />
              {showSubagents && runningSubagents > 0 ? (
                <RowMetaItem
                  dropsFirst
                  label={
                    runningSubagents === 1
                      ? "1 subagent running"
                      : `${runningSubagents} subagents running`
                  }
                >
                  <span
                    role="img"
                    aria-label={
                      runningSubagents === 1
                        ? "1 subagent running"
                        : `${runningSubagents} subagents running`
                    }
                    className={cn("inline-flex shrink-0 items-center gap-1", SIDEBAR_TABULAR_CLS)}
                  >
                    <UsersIcon aria-hidden className="size-3.5 shrink-0" />
                    <span aria-hidden>{runningSubagents}</span>
                  </span>
                </RowMetaItem>
              ) : null}
              {(thread.tags ?? []).map((tag) => (
                <RowMetaItem key={tag} label={`#${tag}`}>
                  <span data-thread-tag="" className={SIDEBAR_THREAD_TAG_CLASS}>
                    #{tag}
                  </span>
                </RowMetaItem>
              ))}
              {regeneratingTitle ? (
                <RowMetaItem label="Renaming title">
                  <span data-thread-regenerating="" className="shrink-0">
                    Renaming…
                  </span>
                </RowMetaItem>
              ) : null}
            </RowMeta>
            {showPullRequest && rowPullRequest !== null ? (
              <span data-thread-pr-slot="" className="inline-flex shrink-0">
                <ThreadRowPullRequestBadge
                  threadRef={threadRef}
                  pullRequest={rowPullRequest}
                  pullRequestCount={thread.pullRequests.length}
                  onOpenThread={onOpen}
                />
              </span>
            ) : null}
            <ThreadDiffCounts
              thread={thread}
              rowRef={rowRef}
              focused={focused}
              emphasized={active || selected}
            />
            {/* A fixed slot, so the marks line up under the statuses whatever the row carries. */}
            <span
              data-thread-provider-mark=""
              className="inline-grid size-4 shrink-0 place-items-center"
            >
              {providerEntry !== undefined ? (
                <SidebarProviderStack
                  thread={thread}
                  providerEntryByInstanceId={providerEntries}
                  quiet
                />
              ) : null}
            </span>
          </div>
        </div>
        {selected ? (
          <span className={SIDEBAR_SR_ONLY_CLS} aria-live="polite">
            Selected
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="start" className="max-w-65">
        <ThreadHoverCard
          thread={thread}
          workspaceTitle={projectTitle}
          providerEntries={providerEntries}
          branchName={branchName}
          nowMs={Date.parse(`${nowMinute}:00.000Z`)}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

export function HoldMenuItems({
  presets,
  onPick,
  onPickTime,
}: {
  presets: ReadonlyArray<SnoozePreset>;
  onPick: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
}) {
  return (
    <>
      <div className={SIDEBAR_MENU_HEADING_CLS}>Hold until</div>
      {presets.map((preset) => (
        <MenuItem key={preset.id} onClick={() => onPick(preset)}>
          {preset.label}
          <span className={SIDEBAR_MENU_HINT_CLS}>{preset.whenLabel}</span>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        onClick={() => {
          void (async () => {
            const picked = await onPickTime();
            if (picked !== null) onPick(picked);
          })();
        }}
      >
        Pick a time…
      </MenuItem>
    </>
  );
}
