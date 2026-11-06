import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@houston-app/client-runtime/state/models";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  AlarmClockOffIcon,
  ChevronRightIcon,
  ClockIcon,
  CpuIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Grid2X2PlusIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  Undo2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { openAddProjectDialog } from "../AddProjectDialog";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { isDesktopHost } from "../../env";
import { getThreadSortTimestamp, sortThreads } from "@houston-app/client-runtime/state/thread-sort";
import {
  DEFAULT_SIDEBAR_GRID_SORT_ORDER,
  DEFAULT_SIDEBAR_GRID_THREAD_SORT_ORDER,
} from "@houston-app/contracts/settings";
import {
  gridById,
  type GridRecord,
  orderedGridsForWorkspace,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";
import { moveThreadToGridOrExplain } from "../../grid/moveToGrid";
import { crossProjectMoveToast, noProjectMoveToast, sameProject } from "../../grid/projectMove";
import { showThreadMovedToast } from "../../grid/moveFeedback";
import { resolveGridThreadTarget } from "../../grid/gridNavigation";
import {
  nextRailTargetIndex,
  pinnedThreadsFirst,
  ungroupedWorkspaceThreads,
} from "../../grid/rail";
import {
  beginThreadDrag,
  useThreadDragSource,
  useThreadDropTarget,
  useThreadDropZone,
  type ThreadDragSource,
} from "../../grid/threadDrag";
import {
  attentionCardsForGrids,
  clearThreadSelection,
  gridThreadStateLabel,
  nextAttentionCard,
  openPullRequestNumber,
  partitionShelfThreads,
  resolveGridThreadState,
  runningSubagentsByParentThread,
  subagentParentKey,
  threadMatchesGridSearch,
  updateThreadSelection,
  visibleGridThreads,
  type AttentionCard,
  type GridThreadState,
  type ThreadSelection,
} from "../../grid/sidebar";
import { PullRequestChecksGlyph, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { GridShelves } from "./GridShelves";
import { useProjectSectionMenu } from "./projectSectionMenu";
import {
  COLLAPSED_GRIDS_STORAGE_KEY,
  COLLAPSED_PROJECTS_STORAGE_KEY,
  useCollapsedKeys,
} from "./sidebarCollapse";
import {
  buildSidebarProjectSections,
  orderSidebarProjectGroups,
  type SidebarProjectSection as SidebarProjectSectionModel,
} from "./sidebarProjectSections";
import { preorderThreads } from "../../grid/tree";
import { useOpenGridDraft } from "../../grid/useOpenGridDraft";
import { useProject, useQuietThreadShells, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { registerSettleAndAdvance } from "../../settleAndAdvance";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useNewThreadHandler, type NewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { AnimatedHeight } from "../AnimatedHeight";
import { isAppModalPage } from "../sidebar/mainAppLocation";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarRailKbd, SidebarRailNav } from "../sidebar/SidebarRailNav";
import { useOpenPullRequestCount } from "../pullRequest/useOpenPullRequestCount";
import { useTaskYourTurnCount } from "../../state/tasks";
import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { ThreadStateGlyph, threadStateTextClass } from "../ui/thread-state-glyph";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../sidebar/sidebarProviderEntries";
import { useSnoozeWakeClock } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Separator } from "../ui/separator";
import {
  FOCUS_ACTION_CLS,
  FOCUS_ROW_CLS,
  ROW_ACTIONS_REVEAL,
  ROW_ACTIONS_VISIBLE,
  ROW_STATUS_HIDDEN,
  ROW_STATUS_RECEDE,
  SidebarContent,
  SidebarHeader,
  useSidebarVisibility,
} from "../ui/sidebar";
import { MOTION_FEEDBACK, MOTION_FEEDBACK_OPACITY } from "../ui/motion-recipes";
import { SIDEBAR_THREAD_TAG_CLASS } from "../ui/thread-tag-recipes";
import {
  SIDEBAR_GRID_ACTION_CLS,
  SIDEBAR_GRID_CHEVRON_BOX_CLS,
  SIDEBAR_GRID_CHEVRON_CLS,
  SIDEBAR_GRID_CHEVRON_EXPANDED_CLS,
  SIDEBAR_GRID_EMPTY_CLS,
  SIDEBAR_GRID_HEADING_ACTIVE_CLS,
  SIDEBAR_GRID_HEADING_CLS,
  SIDEBAR_GRID_HEADING_DROP_CLS,
  SIDEBAR_GRID_COUNT_CLS,
  SIDEBAR_GRID_NAME_CLS,
  SIDEBAR_GRID_RENAME_CLS,
  SIDEBAR_PROJECT_ACTION_CLS,
  SIDEBAR_PROJECT_EMPTY_ACTION_CLS,
  SIDEBAR_PROJECT_LABEL_CLS,
  SIDEBAR_PROJECT_ICON_CLS,
  SIDEBAR_PROJECT_LABEL_TEXT_CLS,
  SIDEBAR_PROJECT_ROW_CLS,
  SIDEBAR_PROJECT_SUMMARY_CLS,
  SIDEBAR_SECTION_ACTION_CLS,
  SIDEBAR_THREAD_NOT_IN_GRID_CLS,
  SidebarOptionsMenu,
  SidebarSectionHeaderRow,
  type SidebarGridOptions,
} from "../ui/sidebar-grids";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

type DraggedThread = ThreadDragSource;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
  return true;
}

function threadTimeLabel(thread: EnvironmentThreadShell, nowMinute: string): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`)).replace(
    / ago$/,
    "",
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
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
      <mark
        key={`${index}-${target}`}
        className="rounded-(--r-badge) bg-(--warn-wash) px-px text-inherit"
      >
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function GridSidebar() {
  const allProjects = useProjects();
  const threads = useQuietThreadShells();
  // Reading the same project groups as the rest of the app makes the rail obey
  // pin, grouping and sort order instead of raw store order.
  const projectGroups = useSidebarProjectGroups();
  const orderedProjectGroups = orderSidebarProjectGroups(projectGroups);
  const projects = orderedProjectGroups.flatMap((group) =>
    group.memberProjects.flatMap((member) => {
      const project = allProjects.find(
        (candidate) =>
          candidate.environmentId === member.environmentId && candidate.id === member.id,
      );
      return project === undefined || project.archivedAt != null ? [] : [project];
    }),
  );
  const grids = useGridStore((store) => store.grids);
  const threadOrigins = useGridStore((store) => store.threadOrigins);
  const createGrid = useGridStore((store) => store.createGrid);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadSort = useClientSettings((settings) => settings.sidebarGridThreadSortOrder);
  const gridSort = useClientSettings((settings) => settings.sidebarGridSortOrder);
  const showBranch = useClientSettings((settings) => settings.sidebarRowShowBranch);
  const showPullRequest = useClientSettings((settings) => settings.sidebarRowShowPullRequest);
  const showSubagents = useClientSettings((settings) => settings.sidebarRowShowSubagents);
  const sidebarOptions: SidebarGridOptions = {
    threadSort,
    gridSort,
    showBranch,
    showPullRequest,
    showSubagents,
  };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const searchShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestCount = useOpenPullRequestCount();
  const taskCount = useTaskYourTurnCount();
  const sidebarVisible = useSidebarVisibility();
  const nowMinute = useNowMinute();
  const wakeClock = useSnoozeWakeClock(threads);
  const nowIso = new Date(wakeClock).toISOString();
  const openGridId = /^\/grid\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const openGrid =
    openGridId === null ? null : (grids.find((grid) => grid.id === openGridId) ?? null);

  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<ThreadSelection>(clearThreadSelection);
  const collapsedGrids = useCollapsedKeys(COLLAPSED_GRIDS_STORAGE_KEY);
  const collapsedProjects = useCollapsedKeys(COLLAPSED_PROJECTS_STORAGE_KEY);
  const dragging = useThreadDragSource();
  const dropTargetSide = useThreadDropTarget();
  const dropTarget =
    dropTargetSide === null
      ? null
      : dropTargetSide.kind === "grid"
        ? `grid:${dropTargetSide.gridId}`
        : dropTargetSide.kind === "closed"
          ? "shelf:closed"
          : null;
  const openGridDraft = useOpenGridDraft();

  const actions = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const openProjectMenu = useProjectSectionMenu();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const openThread = (gridId: string, threadId: string) => {
    useGridStore.getState().focusThread(gridId, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId } });
  };

  const createGridInWorkspace = (workspaceKey: string, name?: string) => {
    const project = projects.find(
      (candidate) => workspaceKeyOf(candidate.environmentId, candidate.id) === workspaceKey,
    );
    if (project === undefined) return;
    const gridId = createGrid({
      environmentId: project.environmentId,
      projectId: project.id,
      workspaceKey,
      ...(name === undefined ? {} : { name }),
    });
    void navigate({ to: "/grid/$gridId", params: { gridId } });
  };

  const createThreadInGrid = (grid: GridRecord) => {
    void openGridDraft({ gridId: grid.id, focusedThreadId: grid.focusedThreadId });
  };

  const threadById = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );

  // The rail's flat order: workspaces, their grids, each grid's panes, then the
  // workspace threads no grid shows. Keyboard traversal and shift-click ranges
  // follow exactly what the rail draws.
  const ungroupedByWorkspace = new Map<string, EnvironmentThreadShell[]>();
  const railTargets = projects.flatMap((project) => {
    const workspaceKey = workspaceKeyOf(project.environmentId, project.id);
    const workspaceGrids = orderedGridsForWorkspace(grids, workspaceKey).filter(
      (grid) => !grid.hidden,
    );
    const gridTargets = workspaceGrids.flatMap((grid) =>
      visibleGridThreads(grid, threads, nowIso).map((thread) => ({
        gridId: grid.id as string | null,
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        threadId: thread.id,
      })),
    );
    const ungrouped = ungroupedWorkspaceThreads({ project, grids, threads, now: nowIso });
    ungroupedByWorkspace.set(
      workspaceKey,
      pinnedThreadsFirst(threadSort === "grid" ? ungrouped : sortThreads(ungrouped, threadSort)),
    );
    return [
      ...gridTargets,
      ...ungrouped.map((thread) => ({
        gridId: null,
        environmentId: thread.environmentId,
        projectId: thread.projectId,
        threadId: thread.id,
      })),
    ];
  });
  const orderedThreadKeys = railTargets.map((target) =>
    scopedThreadKey(scopeThreadRef(target.environmentId, target.threadId)),
  );
  const openRailTarget = (target: (typeof railTargets)[number]) => {
    if (target.gridId !== null) {
      openThread(target.gridId, target.threadId);
      return;
    }
    const resolved = resolveGridThreadTarget({
      environmentId: target.environmentId,
      projectId: target.projectId,
      threadId: target.threadId,
    });
    if (resolved !== null) openThread(resolved.gridId, resolved.threadId);
  };

  // Hidden grids still answer Ctrl .: their threads keep their grid and pane.
  // Ungrouped threads answer too, so an approval cannot hide from the walk.
  const allCards: AttentionCard[] = projects.flatMap((project) => {
    const workspaceKey = workspaceKeyOf(project.environmentId, project.id);
    return [
      ...attentionCardsForGrids(orderedGridsForWorkspace(grids, workspaceKey), threads, nowIso),
      ...(ungroupedByWorkspace.get(workspaceKey) ?? []).map((thread) => ({
        gridId: null,
        threadId: thread.id,
        state: resolveGridThreadState(thread, nowIso),
      })),
    ];
  });

  const currentFocus =
    openGrid === null || openGrid.focusedThreadId === null
      ? null
      : { gridId: openGrid.id, threadId: openGrid.focusedThreadId };

  const removeFromSelection = (threadsToRemove: ReadonlyArray<EnvironmentThreadShell>) => {
    const keys = new Set(
      threadsToRemove.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    setSelection((current) => ({
      selectedThreadKeys: new Set([...current.selectedThreadKeys].filter((key) => !keys.has(key))),
      anchorThreadKey:
        current.anchorThreadKey !== null && keys.has(current.anchorThreadKey)
          ? null
          : current.anchorThreadKey,
    }));
  };

  const closeThreads = (threadsToClose: ReadonlyArray<EnvironmentThreadShell>) => {
    removeFromSelection(threadsToClose);
    const closedKeys = new Set<string>(threadsToClose.map((thread) => thread.id));
    if (
      openGrid !== null &&
      openGrid.focusedThreadId !== null &&
      closedKeys.has(openGrid.focusedThreadId)
    ) {
      const remaining = visibleGridThreads(openGrid, threads, nowIso).filter(
        (thread) => !closedKeys.has(thread.id),
      );
      // Closing the last cell keeps the grid on screen; its empty state offers
      // a draft, and the closed thread is listed on the Closed shelf.
      const next = remaining[0];
      if (next !== undefined) openThread(openGrid.id, next.id);
    }
    for (const thread of threadsToClose) {
      void (async () => {
        const result = await actions.settleThread(scopeThreadRef(thread.environmentId, thread.id));
        reportFailure("Failed to close thread", result);
      })();
    }
  };

  const holdThreads = (
    threadsToHold: ReadonlyArray<EnvironmentThreadShell>,
    snoozedUntil: string,
  ) => {
    removeFromSelection(threadsToHold);
    for (const thread of threadsToHold) {
      void (async () => {
        const result = await actions.snoozeThread(
          scopeThreadRef(thread.environmentId, thread.id),
          snoozedUntil,
        );
        reportFailure("Failed to hold thread", result);
      })();
    }
  };

  const pickHoldTime = async (): Promise<Pick<SnoozePreset, "snoozedUntil"> | null> =>
    requestCustomSnooze();

  const renameThread = (thread: EnvironmentThreadShell, title: string) => {
    if (title.length === 0 || title === thread.title) return;
    void (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: "The server did not accept the new title.",
        });
      }
    })();
  };

  const setAutoClose = (thread: EnvironmentThreadShell, enabled: boolean) => {
    void (async () => {
      const result = await actions.setThreadAutoSettle(
        scopeThreadRef(thread.environmentId, thread.id),
        enabled,
      );
      reportFailure("Failed to change auto-close", result);
    })();
  };

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the module-level settle-and-advance registry pointing at the mounted rail
  useEffect(
    () =>
      registerSettleAndAdvance((threadRef) => {
        const thread = threads.find(
          (candidate) =>
            candidate.environmentId === threadRef.environmentId &&
            candidate.id === threadRef.threadId,
        );
        if (thread !== undefined) closeThreads([thread]);
      }),
    // The registry holds the newest close handler; re-registering costs one assignment.
    [closeThreads, threads],
  );

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the window's Esc and attention shortcuts in step with the visible rail while it is mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !sidebarVisible) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { gridRoute: true, terminalFocus: false, editableFocus: false },
      });
      const direction =
        command === "thread.attentionNext" ? 1 : command === "thread.attentionPrevious" ? -1 : null;
      if (direction === null) return;
      if (
        isEditableFocused(event.target) ||
        isTerminalFocused() ||
        isPreviewFocused() ||
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        isAppModalPage(pathname)
      ) {
        return;
      }
      const card = nextAttentionCard(allCards, currentFocus, direction);
      if (card === null) return;
      event.preventDefault();
      event.stopPropagation();
      const thread = threadById.get(card.threadId);
      if (thread !== undefined) {
        openRailTarget({
          gridId: card.gridId,
          environmentId: thread.environmentId,
          projectId: thread.projectId,
          threadId: thread.id,
        });
      } else if (card.gridId !== null) {
        openThread(card.gridId, card.threadId);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (isEditableFocused(event.target)) return;
      if (selection.selectedThreadKeys.size === 0) return;
      event.preventDefault();
      setSelection(clearThreadSelection());
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onEscape);
    };
  });

  // Thread traversal and jump: the rail owns the order, so Mod+Shift+[ / ] and
  // Mod+1..9 walk the same rows the user sees, including ungrouped threads.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window keydown listener for thread traversal and jump shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        isEditableFocused(event.target) ||
        isTerminalFocused() ||
        isPreviewFocused() ||
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        isAppModalPage(pathname)
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: false, editableFocus: false },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (direction === null && jumpIndex === null) return;
      if (railTargets.length === 0) return;
      const index =
        jumpIndex !== null
          ? jumpIndex
          : nextRailTargetIndex(railTargets, currentFocus, direction ?? "next");
      if (index === null) return;
      const target = railTargets[index];
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      openRailTarget(target);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const selectThread = (
    thread: EnvironmentThreadShell,
    input: { shiftKey: boolean; toggleKey: boolean },
  ) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    setSelection((current) =>
      updateThreadSelection(current, {
        orderedKeys: orderedThreadKeys,
        clickedKey: key,
        shiftKey: input.shiftKey,
        toggleKey: input.toggleKey,
      }),
    );
  };

  const selectedThreads = threads.filter((thread) =>
    selection.selectedThreadKeys.has(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );

  const selectedHoldEnvironmentId = selectedThreads[0]?.environmentId ?? null;
  const selectionPresets =
    selectedHoldEnvironmentId === null
      ? []
      : resolveSnoozePresets(
          new Date(`${nowMinute}:00.000Z`),
          timestampFormat,
          selectedHoldEnvironmentId,
        );

  // A drag lands the thread in the target grid but does not move the user; the
  // toast offers the grid and the way back.
  const moveThreadToGrid = (source: DraggedThread, targetGridId: string) => {
    if (source.gridId === targetGridId) return;
    const thread = threadById.get(source.threadId);
    const target = gridById(useGridStore.getState().grids, targetGridId);
    if (thread === undefined || target === null) return;
    if (thread.projectId.length === 0) {
      toastManager.add(stackedThreadToast({ type: "error", ...noProjectMoveToast(target.name) }));
      return;
    }
    if (!sameProject(thread, target)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          ...crossProjectMoveToast(
            workspaceTitles.get(workspaceKeyOf(thread.environmentId, thread.projectId)) ??
              thread.projectId,
            workspaceTitles.get(target.workspaceKey) ?? target.projectId,
          ),
        }),
      );
      return;
    }
    const refusal = moveThreadToGridOrExplain({
      threadId: source.threadId,
      threadEnvironmentId: thread.environmentId,
      threadProjectId: thread.projectId,
      targetGridId,
    });
    if (refusal !== null) {
      toastManager.add(stackedThreadToast({ type: "error", ...refusal }));
      return;
    }
    showThreadMovedToast({
      threadId: thread.id,
      threadEnvironmentId: thread.environmentId,
      threadProjectId: thread.projectId,
      threadTitle: thread.title,
      sourceGridId: source.gridId,
      targetGridId,
      onOpenTarget: (gridId) => openThread(gridId, thread.id),
    });
  };
  const dropThreadOnThread = (
    source: DraggedThread,
    targetGridId: string,
    targetThreadId: string,
  ) => {
    if (source.gridId === targetGridId) {
      useGridStore.getState().reorderGridThreads(targetGridId, source.threadId, targetThreadId);
      return;
    }
    moveThreadToGrid(source, targetGridId);
  };
  const openReturnedThread = (thread: EnvironmentThreadShell) => {
    const target = resolveGridThreadTarget({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      fromShelf: true,
    });
    if (target !== null) openThread(target.gridId, target.threadId);
  };

  const wakeShelfThread = (thread: EnvironmentThreadShell) => {
    void (async () => {
      const result = await actions.unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to bring thread back", result)) openReturnedThread(thread);
    })();
  };

  const reopenShelfThread = (thread: EnvironmentThreadShell) => {
    void (async () => {
      const result = await actions.unsettleThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to reopen thread", result)) openReturnedThread(thread);
    })();
  };

  const workspaceKeys = new Set(
    projects.map((project) => workspaceKeyOf(project.environmentId, project.id)),
  );
  const workspaceTitles = new Map(
    projects.map((project) => [workspaceKeyOf(project.environmentId, project.id), project.title]),
  );
  const shelves = partitionShelfThreads(threads, workspaceKeys, nowIso);
  const runningSubagentsByThread = runningSubagentsByParentThread(threads, nowIso);
  // A held or closed thread leaves its pane but keeps its slot for the return.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the grid store in step with thread lifecycle from the server
  useEffect(() => {
    for (const grid of grids) {
      if (grid.tree === null) continue;
      for (const leaf of preorderThreads(grid.tree)) {
        const thread = threads.find((candidate) => candidate.id === leaf.threadId);
        if (thread === undefined || thread.archivedAt !== null || thread.deletedAt !== null) {
          continue;
        }
        const shelved =
          thread.settledOverride === "settled" || effectiveSnoozed(thread, { now: nowIso });
        if (!shelved) continue;
        const store = useGridStore.getState();
        if (store.threadOrigins[leaf.threadId] !== undefined) continue;
        store.detachThreadForShelf(leaf.threadId);
      }
    }
  }, [grids, threads, nowIso]);

  // A woken or reopened thread returns to the grid and slot it left.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- keeps the grid store in step with a wake or reopen from the server
  useEffect(() => {
    for (const threadId of Object.keys(threadOrigins)) {
      const thread = threadById.get(threadId);
      if (thread === undefined || thread.archivedAt !== null || thread.deletedAt !== null) {
        continue;
      }
      if (thread.settledOverride === "settled") continue;
      if (effectiveSnoozed(thread, { now: nowIso })) continue;
      useGridStore.getState().returnThreadToOrigin({
        threadId,
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
    }
  }, [threadById, threadOrigins, nowIso]);

  const query = search.trim();
  const searchMatchThreads = [
    ...projects.flatMap((project) =>
      orderedGridsForWorkspace(grids, workspaceKeyOf(project.environmentId, project.id))
        .filter((grid) => !grid.hidden)
        .flatMap((grid) =>
          visibleGridThreads(grid, threads, nowIso).filter((thread) =>
            threadMatchesGridSearch(
              {
                title: thread.title,
                branch: thread.branch,
                pullRequests: thread.pullRequests,
              },
              query,
            ),
          ),
        ),
    ),
    ...projects.flatMap((project) =>
      (ungroupedByWorkspace.get(workspaceKeyOf(project.environmentId, project.id)) ?? []).filter(
        (thread) =>
          threadMatchesGridSearch(
            {
              title: thread.title,
              branch: thread.branch,
              pullRequests: thread.pullRequests,
            },
            query,
          ),
      ),
    ),
  ];

  const hiddenGridGroups = projects.flatMap((project) => {
    const workspaceKey = workspaceKeyOf(project.environmentId, project.id);
    const workspaceHidden = orderedGridsForWorkspace(grids, workspaceKey).filter(
      (grid) => grid.hidden,
    );
    return workspaceHidden.length === 0
      ? []
      : [{ workspaceKey, title: project.title, grids: workspaceHidden }];
  });

  const sections = buildSidebarProjectSections({
    groups: orderedProjectGroups,
    grids,
    threads,
    threadSort,
    gridSort,
    nowIso,
    query,
    activityAt: (grid) => gridActivityAt(grid, threads, nowIso),
  });

  return (
    <>
      <SidebarChromeHeader isDesktopHost={isDesktopHost} />
      <SidebarHeader>
        <SidebarRailNav
          pullRequestCount={pullRequestCount}
          taskCount={taskCount}
          sectionHeading={false}
          search={
            <label className="flex h-7 w-full shrink-0 items-center gap-2 rounded-(--control-radius) px-2 text-sm text-secondary-foreground hover:bg-sidebar-row-hover focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset">
              <SearchIcon aria-hidden className="size-[15px] shrink-0 text-secondary-label" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setSearch("");
                  }
                  if (event.key === "Enter") {
                    const first = searchMatchThreads[0];
                    if (first !== undefined) {
                      const grid = grids.find((candidate) =>
                        visibleGridThreads(candidate, threads, nowIso).some(
                          (thread) => thread.id === first.id,
                        ),
                      );
                      if (grid !== undefined) openThread(grid.id, first.id);
                      else {
                        const target = railTargets.find(
                          (candidate) =>
                            candidate.threadId === first.id &&
                            candidate.environmentId === first.environmentId,
                        );
                        if (target !== undefined) openRailTarget(target);
                      }
                      return;
                    }
                    const matchedGrid = sections
                      .flatMap((section) => section.grids.map((entry) => entry.grid))
                      .find((grid) =>
                        grid.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                      );
                    if (matchedGrid !== undefined) {
                      const candidate = railTargets.find(
                        (target) => target.gridId === matchedGrid.id,
                      );
                      if (candidate !== undefined) openRailTarget(candidate);
                      else
                        void navigate({ to: "/grid/$gridId", params: { gridId: matchedGrid.id } });
                      return;
                    }
                    const matchedProject = projects.find((project) =>
                      project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                    );
                    const workspaceTarget =
                      matchedProject === undefined
                        ? undefined
                        : railTargets.find(
                            (target) => target.environmentId === matchedProject.environmentId,
                          );
                    if (workspaceTarget !== undefined) openRailTarget(workspaceTarget);
                  }
                }}
                placeholder="Search"
                aria-label="Search workspaces, grids and threads"
                className="min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-secondary-label"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                >
                  <XIcon aria-hidden className="size-3" />
                </button>
              ) : searchShortcutLabel ? (
                <SidebarRailKbd>{searchShortcutLabel}</SidebarRailKbd>
              ) : null}
            </label>
          }
        />
      </SidebarHeader>
      <SidebarContent>
        <div className="flex min-h-full flex-col px-2 pb-2">
          <SidebarProjectsHeader
            options={sidebarOptions}
            onChange={(patch) => void updateClientSettings(sidebarOptionsPatch(patch))}
            onReset={() => void updateClientSettings(SIDEBAR_OPTIONS_DEFAULTS)}
            hiddenGridGroups={hiddenGridGroups}
          />
          <div className="flex flex-col gap-px">
            {sections.length === 0 && query.length === 0 ? (
              <p className="px-2 py-3 text-xs text-secondary-label">
                Open a project to create its first grid.
              </p>
            ) : null}
            {sections.map((section) => (
              <SidebarProjectSection
                key={section.projectKey}
                section={section}
                query={query}
                openGridId={openGrid?.id ?? null}
                collapsed={collapsedProjects.collapsed.has(section.projectKey)}
                onToggleCollapsed={() => collapsedProjects.toggle(section.projectKey)}
                collapsedGridIds={collapsedGrids.collapsed}
                onToggleGridCollapsed={collapsedGrids.toggle}
                providerEntries={
                  providerEntriesByEnvironment.get(section.environmentId) ?? EMPTY_PROVIDER_ENTRIES
                }
                nowIso={nowIso}
                selection={selection}
                runningSubagents={runningSubagentsByThread}
                dragging={dragging}
                dropTarget={dropTarget}
                onOpenThread={openThread}
                onSelectThread={selectThread}
                onCloseThread={(thread) => closeThreads([thread])}
                onHoldThread={(thread, preset) => holdThreads([thread], preset.snoozedUntil)}
                onPickHoldTime={pickHoldTime}
                onDropOnGrid={(source, targetGridId) => moveThreadToGrid(source, targetGridId)}
                onDropOnThread={dropThreadOnThread}
                onCreateGrid={() =>
                  createGridInWorkspace(workspaceKeyOf(section.environmentId, section.projectId))
                }
                onOpenProjectMenu={(position) => {
                  const group = projectGroups.find(
                    (candidate) => candidate.projectKey === section.projectKey,
                  );
                  if (group === undefined) return;
                  void openProjectMenu(group, position, () =>
                    createGridInWorkspace(workspaceKeyOf(section.environmentId, section.projectId)),
                  );
                }}
                onCreateThread={(gridId) => {
                  const grid = gridById(grids, gridId);
                  if (grid !== null) createThreadInGrid(grid);
                }}
                onRenameThread={renameThread}
                onSetAutoClose={setAutoClose}
                handleNewThread={handleNewThread}
                onShowGrid={(gridId) => useGridStore.getState().setGridHidden(gridId, false)}
                onOpenUngroupedThread={(thread) =>
                  openRailTarget({
                    gridId: null,
                    environmentId: thread.environmentId,
                    projectId: thread.projectId,
                    threadId: thread.id,
                  })
                }
              />
            ))}
          </div>
        </div>
      </SidebarContent>
      <div className="shrink-0 px-2 pt-1 pb-1" data-testid="grid-shelves-pin">
        <Separator className="mb-1" data-shelves-rule="" />
        <GridShelves
          held={shelves.held}
          closed={shelves.closed}
          closedDropTarget={dropTarget === "shelf:closed"}
          closedDragActive={dragging !== null}
          onClosedDrop={(source) => {
            const thread = threadById.get(source.threadId);
            if (thread !== undefined) closeThreads([thread]);
          }}
          renderCard={(thread, shelf) => (
            <ThreadCard
              key={thread.id}
              gridId={null}
              thread={thread}
              query=""
              providerEntries={
                providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
              }
              nowIso={nowIso}
              focused={false}
              selected={selection.selectedThreadKeys.has(
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              )}
              dragging={false}
              runningSubagents={runningSubagentsByThread.get(subagentParentKey(thread)) ?? 0}
              workspaceTitle={
                workspaceTitles.get(workspaceKeyOf(thread.environmentId, thread.projectId)) ?? ""
              }
              timeLabel={
                shelf === "snoozed" && thread.snoozedUntil !== null
                  ? formatUpcomingTimestamp(thread.snoozedUntil, timestampFormat)
                  : null
              }
              shelf={shelf}
              onOpen={() => {
                if (shelf === "snoozed") wakeShelfThread(thread);
                else reopenShelfThread(thread);
              }}
              onSelect={(input) => selectThread(thread, input)}
              onClose={() => {}}
              onHold={() => {}}
              onPickHoldTime={pickHoldTime}
              onRename={(title) => renameThread(thread, title)}
              onSetAutoClose={() => {}}
              onWake={() => wakeShelfThread(thread)}
              onReopen={() => reopenShelfThread(thread)}
              onDropOnThread={() => {}}
            />
          )}
        />
      </div>
      {selection.selectedThreadKeys.size > 0 ? (
        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-(--r-ctl) border border-sidebar-border bg-(--surface-raised) px-2.5 text-xs text-secondary-foreground">
            <span className="flex-1 truncate font-semibold text-foreground">
              {selection.selectedThreadKeys.size} selected
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex h-6 cursor-pointer items-center rounded-(--r-ctl) border border-(--line-strong) px-2 text-xs text-foreground hover:bg-sidebar-row-hover"
                  />
                }
              >
                Hold
              </MenuTrigger>
              <MenuPopup side="top" align="end">
                {selectionPresets.map((preset) => (
                  <MenuItem
                    key={preset.id}
                    onClick={() => holdThreads(selectedThreads, preset.snoozedUntil)}
                  >
                    {preset.label}
                    <span className="ml-auto text-2xs text-secondary-label">
                      {preset.whenLabel}
                    </span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    void (async () => {
                      const picked = await requestCustomSnooze();
                      if (picked !== null) holdThreads(selectedThreads, picked.snoozedUntil);
                    })();
                  }}
                >
                  Pick a time…
                </MenuItem>
              </MenuPopup>
            </Menu>
            <button
              type="button"
              className="inline-flex h-6 cursor-pointer items-center rounded-(--r-ctl) border border-(--line-strong) px-2 text-xs text-foreground hover:bg-sidebar-row-hover"
              onClick={() => {
                closeThreads(selectedThreads);
                setSelection(clearThreadSelection());
              }}
            >
              Close
            </button>
            <span className="ml-1 inline-flex h-4 items-center rounded-(--r-badge) border border-sidebar-border px-1 text-3xs text-secondary-label">
              Esc
            </span>
          </div>
        </div>
      ) : null}
      <SidebarChromeFooter />
      {dragging !== null ? (
        <span aria-hidden className="sr-only">
          Dragging thread
        </span>
      ) : null}
    </>
  );
}

function HiddenGridsMenu({
  groups,
  onShowGrid,
}: {
  groups: ReadonlyArray<{
    workspaceKey: string;
    title: string;
    grids: ReadonlyArray<GridRecord>;
  }>;
  onShowGrid: (gridId: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button type="button" aria-label="Hidden grids" className={SIDEBAR_SECTION_ACTION_CLS} />
        }
      >
        <MoreHorizontalIcon aria-hidden className="size-[15px]" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {groups.map((group) => (
          <MenuSub key={group.workspaceKey}>
            <MenuSubTrigger>
              {group.title}
              <ChevronRightIcon aria-hidden className="ml-auto size-3.5 text-secondary-label" />
            </MenuSubTrigger>
            <MenuSubPopup>
              {group.grids.map((grid) => (
                <MenuItem key={grid.id} onClick={() => onShowGrid(grid.id)}>
                  <EyeOffIcon aria-hidden className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{grid.name}</span>
                  <span className="text-2xs text-secondary-label">Show</span>
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ))}
      </MenuPopup>
    </Menu>
  );
}

async function deleteGridWithConfirm(
  grid: GridRecord,
  deleteGrid: (gridId: string) => void,
): Promise<void> {
  const { requestConfirmDialog } = await import("../../confirmDialog");
  const confirmed =
    (await requestConfirmDialog(
      `Delete the grid “${grid.name}”? Its threads stay in the project and appear under its grids.`,
      { variant: "destructive" },
    )) ?? false;
  if (confirmed) deleteGrid(grid.id);
}

/** The Projects header's controls: hidden grids, the view options, then Add project. */
export function SidebarProjectsHeader({
  options,
  onChange,
  onReset,
  hiddenGridGroups = [],
}: {
  options: SidebarGridOptions;
  onChange: (patch: Partial<SidebarGridOptions>) => void;
  onReset: () => void;
  hiddenGridGroups?: ReadonlyArray<{
    workspaceKey: string;
    title: string;
    grids: ReadonlyArray<GridRecord>;
  }>;
}) {
  return (
    <SidebarSectionHeaderRow
      title="Projects"
      actions={
        <>
          {hiddenGridGroups.length > 0 ? (
            <HiddenGridsMenu
              groups={hiddenGridGroups}
              onShowGrid={(gridId) => useGridStore.getState().setGridHidden(gridId, false)}
            />
          ) : null}
          <SidebarOptionsMenu options={options} onChange={onChange} onReset={onReset} />
          <SidebarAddProjectButton />
        </>
      }
    />
  );
}

/** The Projects header's Add project: opens the chooser for a folder, a clone or a new repository. */
export function SidebarAddProjectButton() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Add project"
            onClick={() => openAddProjectDialog()}
            className={SIDEBAR_SECTION_ACTION_CLS}
          />
        }
      >
        <PlusIcon aria-hidden className="size-[15px]" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Add project</TooltipPopup>
    </Tooltip>
  );
}

/** A project's grids, then the threads no grid shows, under one collapsible label. */
export function SidebarProjectSection({
  section,
  query,
  openGridId,
  collapsed,
  onToggleCollapsed,
  collapsedGridIds,
  onToggleGridCollapsed,
  providerEntries,
  nowIso,
  selection,
  runningSubagents,
  dragging,
  dropTarget,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onDropOnGrid,
  onDropOnThread,
  onCreateGrid,
  onCreateThread,
  onRenameThread,
  onSetAutoClose,
  handleNewThread,
  onShowGrid,
  onOpenUngroupedThread,
  onOpenProjectMenu,
}: {
  section: SidebarProjectSectionModel;
  query: string;
  openGridId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  collapsedGridIds: ReadonlySet<string>;
  onToggleGridCollapsed: (gridId: string) => void;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  selection: ThreadSelection;
  runningSubagents: ReadonlyMap<string, number>;
  dragging: DraggedThread | null;
  dropTarget: string | null;
  onOpenThread: (gridId: string, threadId: string) => void;
  onSelectThread: (
    thread: EnvironmentThreadShell,
    input: { shiftKey: boolean; toggleKey: boolean },
  ) => void;
  onCloseThread: (thread: EnvironmentThreadShell) => void;
  onHoldThread: (
    thread: EnvironmentThreadShell,
    preset: Pick<SnoozePreset, "snoozedUntil">,
  ) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onDropOnGrid: (source: DraggedThread, targetGridId: string) => void;
  onDropOnThread: (source: DraggedThread, targetGridId: string, targetThreadId: string) => void;
  onCreateGrid: () => void;
  onCreateThread: (gridId: string) => void;
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  handleNewThread?: NewThreadHandler | undefined;
  onShowGrid: (gridId: string) => void;
  onOpenUngroupedThread: (thread: EnvironmentThreadShell) => void;
  /** Opens the project's actions at a viewport point; the scratch section has none. */
  onOpenProjectMenu?: ((position: { x: number; y: number }) => void) | undefined;
}) {
  const gridCount = section.grids.length;
  const projectMenu = section.isScratch ? undefined : onOpenProjectMenu;
  const summary = gridCount === 0 ? "No grids" : gridCount === 1 ? "1 grid" : `${gridCount} grids`;

  return (
    <div
      className="flex flex-col gap-px"
      data-project-key={section.isScratch ? "no-project" : section.projectKey}
    >
      <div className={SIDEBAR_PROJECT_ROW_CLS}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={onToggleCollapsed}
                onContextMenu={(event) => {
                  if (projectMenu === undefined) return;
                  event.preventDefault();
                  projectMenu({ x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (projectMenu === undefined) return;
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
                    return;
                  }
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  projectMenu({ x: rect.left, y: rect.bottom + 4 });
                }}
                className={SIDEBAR_PROJECT_LABEL_CLS}
              >
                {collapsed ? (
                  <FolderIcon aria-hidden className={SIDEBAR_PROJECT_ICON_CLS} />
                ) : (
                  <FolderOpenIcon aria-hidden className={SIDEBAR_PROJECT_ICON_CLS} />
                )}
                <span className={SIDEBAR_PROJECT_LABEL_TEXT_CLS}>{section.title}</span>
                {collapsed ? <span className={SIDEBAR_PROJECT_SUMMARY_CLS}>{summary}</span> : null}
              </button>
            }
          />
          <TooltipPopup side="bottom" align="start">
            {section.title}
          </TooltipPopup>
        </Tooltip>
        {section.isScratch ? null : (
          <span className="absolute inset-y-0 right-1 flex items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New grid in ${section.title}`}
                    onClick={onCreateGrid}
                    className={SIDEBAR_PROJECT_ACTION_CLS}
                  />
                }
              >
                <Grid2X2PlusIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom" align="end">
                {`New grid in ${section.title}`}
              </TooltipPopup>
            </Tooltip>
          </span>
        )}
      </div>
      <AnimatedHeight>
        {collapsed ? null : (
          <div className="flex flex-col gap-px">
            {section.grids.map(({ grid, threads }) => (
              <GridGroup
                key={grid.id}
                grid={grid}
                workspaceTitle={section.title}
                threads={threads}
                query={query}
                open={openGridId === grid.id}
                collapsed={query.length === 0 && collapsedGridIds.has(grid.id)}
                onToggleCollapsed={() => onToggleGridCollapsed(grid.id)}
                providerEntries={providerEntries}
                nowIso={nowIso}
                selection={selection}
                runningSubagents={runningSubagents}
                dragging={dragging}
                dropTarget={dropTarget}
                hiddenGrids={section.hiddenGrids}
                onOpenThread={onOpenThread}
                onSelectThread={onSelectThread}
                onCloseThread={onCloseThread}
                onHoldThread={onHoldThread}
                onPickHoldTime={onPickHoldTime}
                onDropOnGrid={onDropOnGrid}
                onDropOnThread={onDropOnThread}
                onCreateThread={() => onCreateThread(grid.id)}
                onRenameThread={onRenameThread}
                onSetAutoClose={onSetAutoClose}
                handleNewThread={handleNewThread}
                onShowGrid={onShowGrid}
                onCreateGrid={onCreateGrid}
              />
            ))}
            {gridCount === 0 && !section.isScratch ? (
              <button
                type="button"
                aria-label="New grid"
                onClick={onCreateGrid}
                className={SIDEBAR_PROJECT_EMPTY_ACTION_CLS}
              >
                <Grid2X2PlusIcon aria-hidden className="size-3.5" />
                <span>New grid</span>
              </button>
            ) : null}
            {section.ungroupedThreads.map((thread) => (
              <ThreadCard
                key={thread.id}
                gridId={null}
                thread={thread}
                query={query}
                providerEntries={providerEntries}
                nowIso={nowIso}
                focused={false}
                selected={selection.selectedThreadKeys.has(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                )}
                dragging={dragging?.threadId === thread.id}
                workspaceTitle={section.title}
                notInGrid
                runningSubagents={runningSubagents.get(subagentParentKey(thread)) ?? 0}
                onOpen={() => onOpenUngroupedThread(thread)}
                onSelect={(input) => onSelectThread(thread, input)}
                onClose={() => onCloseThread(thread)}
                onHold={(preset) => onHoldThread(thread, preset)}
                onPickHoldTime={onPickHoldTime}
                onRename={(title) => onRenameThread(thread, title)}
                onSetAutoClose={(enabled) => onSetAutoClose(thread, enabled)}
                onDropOnThread={() => {}}
                onOpenGrid={() => onOpenUngroupedThread(thread)}
                handleNewThread={handleNewThread}
              />
            ))}
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
}

export function GridGroup({
  grid,
  workspaceTitle,
  threads,
  query,
  open,
  collapsed,
  onToggleCollapsed,
  providerEntries,
  nowIso,
  selection,
  runningSubagents,
  dragging,
  dropTarget,
  hiddenGrids,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onDropOnGrid,
  onDropOnThread,
  onCreateThread,
  onRenameThread,
  onSetAutoClose,
  handleNewThread,
  onShowGrid,
  onCreateGrid,
}: {
  grid: GridRecord;
  workspaceTitle: string;
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  handleNewThread?: NewThreadHandler | undefined;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  query: string;
  open: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  selection: ThreadSelection;
  runningSubagents: ReadonlyMap<string, number>;
  dragging: DraggedThread | null;
  dropTarget: string | null;
  hiddenGrids: ReadonlyArray<GridRecord>;
  onOpenThread: (gridId: string, threadId: string) => void;
  onSelectThread: (
    thread: EnvironmentThreadShell,
    input: { shiftKey: boolean; toggleKey: boolean },
  ) => void;
  onCloseThread: (thread: EnvironmentThreadShell) => void;
  onHoldThread: (
    thread: EnvironmentThreadShell,
    preset: Pick<SnoozePreset, "snoozedUntil">,
  ) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onDropOnGrid: (source: DraggedThread, targetGridId: string) => void;
  onDropOnThread: (source: DraggedThread, targetGridId: string, targetThreadId: string) => void;
  onCreateThread: () => void;
  onShowGrid: (gridId: string) => void;
  onCreateGrid: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(grid.name);
  const renameGrid = useGridStore((store) => store.renameGrid);
  const pinGrid = useGridStore((store) => store.pinGrid);
  const unpinGrid = useGridStore((store) => store.unpinGrid);
  const setGridHidden = useGridStore((store) => store.setGridHidden);
  const deleteGrid = useGridStore((store) => store.deleteGrid);
  const moveGridInWorkspace = useGridStore((store) => store.moveGridInWorkspace);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const newThreadShortcut = shortcutLabelForCommand(keybindings, "chat.new");
  const manualOrder = useClientSettings((settings) => settings.sidebarGridSortOrder === "manual");
  const isDropTarget = dropTarget === `grid:${grid.id}`;
  const headerRef = useRef<HTMLDivElement | null>(null);
  useThreadDropZone(
    headerRef,
    () => ({ kind: "grid", gridId: grid.id }),
    (source) => onDropOnGrid(source, grid.id),
  );
  const readyThreads = threads.filter(
    (thread) => resolveGridThreadState(thread, nowIso) === "ready",
  );
  const closeAllReady = () => {
    for (const thread of readyThreads) onCloseThread(thread);
  };
  const startRenaming = () => {
    setName(grid.name);
    setRenaming(true);
  };
  const finishRenaming = () => {
    renameGrid(grid.id, name);
    setRenaming(false);
  };

  const gridMenuItems = (
    <>
      <MenuItem onClick={onCreateThread}>New thread</MenuItem>
      <MenuItem onClick={startRenaming}>
        Rename grid
        <MenuShortcut>F2</MenuShortcut>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => (grid.pinnedAt === null ? pinGrid(grid.id) : unpinGrid(grid.id))}>
        {grid.pinnedAt === null ? "Pin grid" : "Unpin grid"}
      </MenuItem>
      {manualOrder ? (
        <>
          <MenuItem onClick={() => moveGridInWorkspace(grid.id, -1)}>Move grid up</MenuItem>
          <MenuItem onClick={() => moveGridInWorkspace(grid.id, 1)}>Move grid down</MenuItem>
        </>
      ) : null}
      <MenuItem onClick={() => setGridHidden(grid.id, true)}>Hide grid</MenuItem>
      <MenuItem onClick={() => void deleteGridWithConfirm(grid, deleteGrid)}>Delete grid</MenuItem>
      <MenuSeparator />
      <MenuItem disabled={readyThreads.length === 0} onClick={closeAllReady}>
        Close all ready
      </MenuItem>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger>
          Workspace
          <ChevronRightIcon aria-hidden className="ml-auto size-3.5 text-secondary-label" />
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuItem onClick={onCreateGrid}>New grid in {workspaceTitle}</MenuItem>
          {hiddenGrids.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>
                Show hidden grids
                <ChevronRightIcon aria-hidden className="ml-auto size-3.5 text-secondary-label" />
              </MenuSubTrigger>
              <MenuSubPopup>
                {hiddenGrids.map((hiddenGrid) => (
                  <MenuItem key={hiddenGrid.id} onClick={() => onShowGrid(hiddenGrid.id)}>
                    <EyeOffIcon aria-hidden className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{hiddenGrid.name}</span>
                    <span className="text-2xs text-secondary-label">Show</span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
        </MenuSubPopup>
      </MenuSub>
    </>
  );

  return (
    <div className="mt-1 flex flex-col gap-px" data-grid-key={grid.id}>
      <div ref={headerRef} className="group/grid relative flex items-center">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={finishRenaming}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(grid.name);
                setRenaming(false);
              }
            }}
            className={SIDEBAR_GRID_RENAME_CLS}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      startRenaming();
                    }
                  }}
                  aria-expanded={!collapsed}
                  className={cn(
                    SIDEBAR_GRID_HEADING_CLS,
                    // One selection fill at a time: the focused thread row carries it while visible.
                    open &&
                      (collapsed ||
                        !threads.some((thread) => thread.id === grid.focusedThreadId)) &&
                      SIDEBAR_GRID_HEADING_ACTIVE_CLS,
                    isDropTarget && SIDEBAR_GRID_HEADING_DROP_CLS,
                  )}
                >
                  <span className={SIDEBAR_GRID_CHEVRON_BOX_CLS} data-grid-chevron-box="">
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        SIDEBAR_GRID_CHEVRON_CLS,
                        !collapsed && SIDEBAR_GRID_CHEVRON_EXPANDED_CLS,
                      )}
                    />
                  </span>
                  <span className={SIDEBAR_GRID_NAME_CLS}>
                    <HighlightedText text={grid.name} query={query} />
                  </span>
                  {threads.length === 0 ? (
                    <span className={SIDEBAR_GRID_EMPTY_CLS}>empty</span>
                  ) : collapsed ? (
                    <span className={SIDEBAR_GRID_COUNT_CLS}>{threads.length}</span>
                  ) : null}
                </button>
              }
            />
            <TooltipPopup side="bottom" align="start">
              {grid.name}
            </TooltipPopup>
          </Tooltip>
        )}
        {renaming ? null : (
          <>
            <span className="absolute inset-y-0 right-7 flex items-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${grid.name}`}
                      onClick={onCreateThread}
                      className={SIDEBAR_GRID_ACTION_CLS}
                    />
                  }
                >
                  <MessageSquarePlusIcon aria-hidden className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {newThreadShortcut === null
                    ? `New thread in ${grid.name}`
                    : `New thread in ${grid.name} · ${newThreadShortcut}`}
                </TooltipPopup>
              </Tooltip>
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Grid actions for ${grid.name}`}
                    className={cn(
                      SIDEBAR_GRID_ACTION_CLS,
                      "absolute right-1 top-1/2 -translate-y-1/2",
                    )}
                  />
                }
              >
                <MoreHorizontalIcon aria-hidden className="size-3.5" />
              </MenuTrigger>
              <MenuPopup side="bottom" align="end">
                {gridMenuItems}
              </MenuPopup>
            </Menu>
          </>
        )}
      </div>
      <AnimatedHeight>
        {collapsed ? null : (
          <div className="flex flex-col gap-px">
            {threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                gridId={grid.id}
                thread={thread}
                query={query}
                providerEntries={providerEntries}
                nowIso={nowIso}
                focused={open && grid.focusedThreadId === thread.id}
                selected={selection.selectedThreadKeys.has(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                )}
                dragging={dragging?.threadId === thread.id}
                runningSubagents={runningSubagents.get(subagentParentKey(thread)) ?? 0}
                workspaceTitle={workspaceTitle}
                onOpen={() => onOpenThread(grid.id, thread.id)}
                onSelect={(input) => onSelectThread(thread, input)}
                onClose={() => onCloseThread(thread)}
                onHold={(preset) => onHoldThread(thread, preset)}
                onPickHoldTime={onPickHoldTime}
                onRename={(title) => onRenameThread(thread, title)}
                onSetAutoClose={(enabled) => onSetAutoClose(thread, enabled)}
                onDropOnThread={(source) => onDropOnThread(source, grid.id, thread.id)}
                onOpenGrid={(targetGridId) => onOpenThread(targetGridId, thread.id)}
                handleNewThread={handleNewThread}
              />
            ))}
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
}

function ThreadStateMark({
  state,
  startedAt,
}: {
  state: GridThreadState;
  startedAt: string | null;
}) {
  if (state === "idle") return null;
  const elapsed =
    state === "running" && startedAt !== null ? <RunningElapsed startedAt={startedAt} /> : null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-caption leading-3.75 font-medium whitespace-nowrap tabular-nums",
        threadStateTextClass(state),
      )}
    >
      <ThreadStateGlyph state={state} />
      <span>{gridThreadStateLabel(state)}</span>
      {elapsed}
    </span>
  );
}

function RunningElapsed({ startedAt }: { startedAt: string }) {
  const nowMs = useNowSecond();
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  return <span>{formatWorkingDurationLabel(nowMs - startedMs)}</span>;
}

/**
 * The branch a thread works on: the one it recorded, or else the branch its
 * checkout (its worktree, or the project's own folder) currently has.
 */
function useThreadBranchName(thread: EnvironmentThreadShell): string | null {
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
  return thread.branch ?? status.data?.refName ?? null;
}

export function ThreadCard({
  gridId,
  thread,
  query,
  providerEntries,
  nowIso,
  focused,
  selected,
  dragging,
  workspaceTitle,
  timeLabel = null,
  shelf = null,
  runningSubagents = 0,
  notInGrid = false,
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
  onOpenGrid,
  handleNewThread,
}: {
  gridId: string | null;
  thread: EnvironmentThreadShell;
  query: string;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  nowIso: string;
  focused: boolean;
  selected: boolean;
  dragging: boolean;
  workspaceTitle: string;
  timeLabel?: string | null;
  shelf?: "snoozed" | "settled" | null;
  runningSubagents?: number;
  /** A thread no grid shows: its row sits at project level and its meta says so. */
  notInGrid?: boolean;
  onOpen: () => void;
  onSelect: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onClose: () => void;
  onHold: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onPickHoldTime: () => Promise<Pick<SnoozePreset, "snoozedUntil"> | null>;
  onRename: (title: string) => void;
  onSetAutoClose: (enabled: boolean) => void;
  onWake?: () => void;
  onReopen?: () => void;
  onDropOnThread: (source: DraggedThread) => void;
  /** Opens the grid a menu move landed in; absent hides the Move to grid submenu. */
  onOpenGrid?: ((gridId: string) => void) | undefined;
  /** Supplies New thread on branch; absent hides that item. */
  handleNewThread?: NewThreadHandler | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(thread.title);
  const [actionsHovered, setActionsHovered] = useState(false);
  const [holdMenuOpen, setHoldMenuOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const nowMinute = useNowMinute();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const showBranch = useClientSettings((settings) => settings.sidebarRowShowBranch);
  const branchName = useThreadBranchName(thread);
  const showPullRequest = useClientSettings((settings) => settings.sidebarRowShowPullRequest);
  const showSubagents = useClientSettings((settings) => settings.sidebarRowShowSubagents);
  const state = resolveGridThreadState(thread, nowIso);
  const attention = state === "needs" || state === "ready" || state === "back";
  const startedAt = resolveThreadWorkingStartedAt(thread);
  const pullRequestNumber = openPullRequestNumber(thread);
  const pullRequestChecksState =
    thread.pullRequests.find((entry) => entry.number === pullRequestNumber)?.snapshot
      ?.checksState ?? null;
  const providerEntry = providerEntries.get(thread.providerInstanceId);
  const presets = resolveSnoozePresets(
    new Date(`${nowMinute}:00.000Z`),
    timestampFormat,
    thread.environmentId,
  );
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const modelLabel = thread.modelSelection?.model ?? null;
  const actionsVisible = actionsHovered || holdMenuOpen || actionsMenuOpen;
  const [previewOpen, setPreviewOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const startRename = () => {
    setName(thread.title);
    setRenaming(true);
  };
  const openCardMenu = async (position: { x: number; y: number }) => {
    setActionsMenuOpen(true);
    await openMenu(position).finally(() => setActionsMenuOpen(false));
  };
  const openCardMenuFromButton = () => {
    const rect = actionsButtonRef.current?.getBoundingClientRect();
    if (rect === undefined || rect === null) return;
    void openCardMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openCardMenuFromRow = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect === undefined || rect === null) return;
    void openCardMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const { openMenu } = useThreadActionMenu({
    threadRef,
    thread,
    onStartRename: startRename,
    handleNewThread,
    grid: {
      currentGridId: gridId,
      isFocusedCell: focused,
      onOpen,
      ...(onOpenGrid === undefined ? {} : { onOpenGrid }),
    },
    onCloseThread: onClose,
    onHoldThread: (snoozedUntil) => onHold({ snoozedUntil }),
    onSetAutoSettle: onSetAutoClose,
  });

  const applyPreset = (preset: Pick<SnoozePreset, "snoozedUntil"> | undefined) => {
    if (preset !== undefined) onHold(preset);
  };

  const close = () => {
    onClose();
  };

  // Hidden, not disabled, while the actions are in use: a disabled tooltip ignores the pointer
  // leaving the row, so a hover open still pending would land after the pointer was gone.
  const previewSuppressed = actionsHovered || holdMenuOpen || actionsMenuOpen;

  const startRowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (renaming || shelf !== null) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("input, textarea, [contenteditable='true']") !== null) return;
      // The title button starts the drag; the row's other controls keep their click.
      const control = target.closest("button, a, [role='button']");
      if (control !== null && !control.hasAttribute("data-card-open")) return;
    }
    beginThreadDrag(event, {
      gridId,
      threadId: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
  };
  useThreadDropZone(
    rowRef,
    (_point, source) =>
      shelf === null && source.threadId !== thread.id
        ? { kind: "thread", gridId, threadId: thread.id }
        : null,
    (source) => onDropOnThread(source),
  );

  return (
    <Tooltip open={previewOpen && !previewSuppressed} onOpenChange={setPreviewOpen}>
      <TooltipTrigger
        render={
          <div
            ref={rowRef}
            onPointerDown={startRowDrag}
            tabIndex={-1}
            data-thread-key={threadKey}
            onContextMenu={(event) => {
              if (renaming) return;
              event.preventDefault();
              void openCardMenu({ x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              openCardMenuFromRow();
            }}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("button, input, [role='button'], [role='menu']") !== null
              ) {
                return;
              }
              if (event.shiftKey || event.metaKey || event.ctrlKey) {
                onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                return;
              }
              onOpen();
            }}
            className={cn(
              `group/th relative flex w-full flex-col gap-1 rounded-lg py-2 pr-2.5 text-left outline-none ${MOTION_FEEDBACK} ${FOCUS_ROW_CLS}`,
              notInGrid ? "pl-2" : "pl-7.5",
              "cursor-pointer",
              dragging && "opacity-50",
              selected
                ? "bg-(--row-current)"
                : focused
                  ? "bg-(--sidebar-row-active)"
                  : "hover:bg-(--sidebar-row-hover)",
            )}
          />
        }
      >
        <div className="flex min-h-[22px] min-w-0 items-center gap-2">
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                setRenaming(false);
                onRename(name.trim());
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(thread.title);
                  setRenaming(false);
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:border-ring"
            />
          ) : (
            <button
              type="button"
              data-card-open=""
              onClick={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                  event.preventDefault();
                  onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
                  return;
                }
                onOpen();
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  setName(thread.title);
                  setRenaming(true);
                }
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-headline leading-4.75 text-foreground",
                  attention ? "font-semibold" : "font-medium",
                )}
              >
                <HighlightedText text={thread.title} query={query} />
              </span>
              <span
                className={cn(
                  "shrink-0",
                  ROW_STATUS_RECEDE,
                  MOTION_FEEDBACK_OPACITY,
                  actionsVisible && ROW_STATUS_HIDDEN,
                )}
              >
                <span className="text-xs text-secondary-label tabular-nums">
                  {timeLabel ?? threadTimeLabel(thread, nowMinute)}
                </span>
              </span>
            </button>
          )}
          <span
            className={cn(
              "absolute top-2 right-2.5 flex h-[22px] items-center gap-0.5",
              MOTION_FEEDBACK_OPACITY,
              actionsVisible ? ROW_ACTIONS_VISIBLE : ROW_ACTIONS_REVEAL,
            )}
            onMouseEnter={() => setActionsHovered(true)}
            onMouseLeave={() => setActionsHovered(false)}
          >
            {shelf !== null ? (
              <button
                type="button"
                aria-label={shelf === "snoozed" ? "Wake thread now" : "Reopen thread"}
                onClick={shelf === "snoozed" ? onWake : onReopen}
                className={cn(
                  "inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground hover:bg-(--sel) hover:text-foreground",
                  FOCUS_ACTION_CLS,
                )}
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
                <Menu onOpenChange={setHoldMenuOpen}>
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Hold"
                        className={cn(
                          "inline-grid size-[22px] cursor-pointer place-items-center rounded-(--r-badge) text-secondary-foreground hover:bg-(--sel) hover:text-foreground",
                          FOCUS_ACTION_CLS,
                        )}
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
                <button
                  type="button"
                  aria-label="Close thread"
                  onClick={close}
                  className={cn(
                    "inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground hover:bg-(--sel) hover:text-foreground",
                    FOCUS_ACTION_CLS,
                  )}
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
                  className={cn(
                    "inline-grid size-5.5 cursor-pointer place-items-center rounded-(--r-badge) text-secondary-foreground hover:bg-(--sel) hover:text-foreground",
                    FOCUS_ACTION_CLS,
                  )}
                >
                  <MoreHorizontalIcon aria-hidden className="size-3.5" />
                </button>
              </>
            )}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-caption leading-3.75 text-secondary-label">
          {showBranch ? (
            <>
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                {branchName ?? "no branch"}
                {notInGrid ? " · not in a grid" : ""}
              </span>
            </>
          ) : notInGrid ? (
            <span className={SIDEBAR_THREAD_NOT_IN_GRID_CLS}>not in a grid</span>
          ) : (
            <span className="flex-1" />
          )}
          {showSubagents && runningSubagents > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <UsersIcon aria-hidden className="size-3 shrink-0" />
              {runningSubagents === 1
                ? "1 subagent running"
                : `${runningSubagents} subagents running`}
            </span>
          ) : null}
          {showPullRequest && pullRequestNumber !== null ? (
            <span className="inline-flex shrink-0 items-center gap-0.75 tabular-nums">
              <PullRequestGlyph.pullRequest aria-hidden className="size-3 shrink-0" />
              <span>#{pullRequestNumber}</span>
              {pullRequestChecksState === null ? null : (
                <PullRequestChecksGlyph state={pullRequestChecksState} />
              )}
            </span>
          ) : null}
          <span
            data-thread-provider-mark=""
            className={cn(
              "inline-grid size-3.5 shrink-0 place-items-center",
              ROW_STATUS_RECEDE,
              MOTION_FEEDBACK_OPACITY,
              actionsVisible && ROW_STATUS_HIDDEN,
            )}
          >
            {providerEntry !== undefined ? (
              <SidebarProviderStack thread={thread} providerEntryByInstanceId={providerEntries} />
            ) : null}
          </span>
        </div>
        {/* Every row is three lines tall: the third says what the agent is doing, then its tags. */}
        <div
          data-thread-status=""
          className="flex min-w-0 items-center gap-1.5 text-caption leading-3.75 text-secondary-label"
        >
          {state === "idle" ? (
            <span>Idle</span>
          ) : (
            <ThreadStateMark state={state} startedAt={startedAt} />
          )}
          {(thread.tags ?? []).map((tag) => (
            <span key={tag} data-thread-tag="" className={SIDEBAR_THREAD_TAG_CLASS}>
              {tag}
            </span>
          ))}
        </div>
        {selected ? (
          <span className="sr-only" aria-live="polite">
            Selected
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="start" className="max-w-65">
        <div className="flex flex-col gap-1.5 px-3 py-2.5 text-xs leading-4 text-secondary-foreground">
          <span className="text-xs leading-4 font-semibold text-foreground">{thread.title}</span>
          <span className="flex items-center gap-1.5">
            <ChevronRightIcon aria-hidden className="size-3" />
            {workspaceTitle}
          </span>
          <span className="flex items-center gap-1.5">
            <GitBranchIcon aria-hidden className="size-3" />
            {branchName ?? "no branch"}
          </span>
          <span className="flex items-center gap-1.5">
            <CpuIcon aria-hidden className="size-3" />
            {modelLabel ?? "model"}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function HoldMenuItems({
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
      <div className="px-2 pt-1 pb-1 text-2xs font-semibold text-secondary-label">Hold until</div>
      {presets.map((preset) => (
        <MenuItem key={preset.id} onClick={() => onPick(preset)}>
          {preset.label}
          <span className="ml-auto text-2xs text-secondary-label">{preset.whenLabel}</span>
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

const SIDEBAR_OPTIONS_DEFAULTS = {
  sidebarGridThreadSortOrder: DEFAULT_SIDEBAR_GRID_THREAD_SORT_ORDER,
  sidebarGridSortOrder: DEFAULT_SIDEBAR_GRID_SORT_ORDER,
  sidebarRowShowBranch: true,
  sidebarRowShowPullRequest: true,
  sidebarRowShowSubagents: true,
} as const;

function sidebarOptionsPatch(patch: Partial<SidebarGridOptions>) {
  return {
    ...(patch.threadSort === undefined ? {} : { sidebarGridThreadSortOrder: patch.threadSort }),
    ...(patch.gridSort === undefined ? {} : { sidebarGridSortOrder: patch.gridSort }),
    ...(patch.showBranch === undefined ? {} : { sidebarRowShowBranch: patch.showBranch }),
    ...(patch.showPullRequest === undefined
      ? {}
      : { sidebarRowShowPullRequest: patch.showPullRequest }),
    ...(patch.showSubagents === undefined ? {} : { sidebarRowShowSubagents: patch.showSubagents }),
  };
}

/** A grid's last activity for the rail's "Last activity" order: its newest thread, else its creation. */
function gridActivityAt(
  grid: GridRecord,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  nowIso: string,
): number {
  const created = Date.parse(grid.createdAt);
  return visibleGridThreads(grid, threads, nowIso).reduce(
    (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, "updated_at")),
    Number.isNaN(created) ? Number.NEGATIVE_INFINITY : created,
  );
}
