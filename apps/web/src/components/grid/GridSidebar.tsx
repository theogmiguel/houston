import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@houston-app/client-runtime/state/runtime";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { canSnooze, effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  AlarmClockOffIcon,
  ChevronRightIcon,
  ClockIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
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
  useContext,
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
  nextAttentionCard,
  resolveRowPullRequest,
  partitionShelfThreads,
  resolveGridThreadState,
  runningSubagentsByParentThread,
  subagentParentKey,
  threadMatchesGridSearch,
  updateThreadSelection,
  visibleGridThreads,
  type AttentionCard,
  type ThreadSelection,
} from "../../grid/sidebar";
import { collapsedRollup, revealedOpenThread } from "../../grid/collapsedRollup";
import { ThreadRowPullRequestBadge } from "./ThreadRowPullRequestBadge";
import { SidebarStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { closedAgeLabel } from "../../grid/statusWord";
import {
  activeProjectFilterKeys,
  applyProjectFilter,
  groupContainsWorkspace,
} from "../../grid/projectFilter";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import {
  ProjectFilterContext,
  ProjectFilterPicker,
  useThreadProjectFilter,
} from "./ProjectFilterPicker";
import { jumpHintLabels } from "../../grid/jumpHints";
import { useRevealOpenThread } from "../../grid/useRevealOpenThread";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { reportFailure } from "./reportFailure";
import { SidebarNoProjects } from "./SidebarNoProjects";
import { ThreadBulkMenuContext, useBulkThreadMenu } from "./useBulkThreadMenu";
import { ThreadTitleInput } from "./threadTitleInput";
import { JumpHintBadge, ThreadJumpHintContext, useThreadJumpHint } from "./threadJumpHints";
import { ThreadStateMark } from "./threadStatusMark";
import { ThreadCheckoutMark, ThreadRowIndicators } from "./threadRowIndicators";
import { GridShelves } from "./GridShelves";
import { readLocalApi } from "../../localApi";
import { ThreadContextDragGhost } from "../chat/ThreadContextDragGhost";
import { RowActionSweepContext, type RowActionSweep } from "./rowActionSweepContext";
import { beginRowActionSweep, sweepActionProps } from "../../grid/rowActionSweep";
import { useRowFileDrop } from "./useRowFileDrop";
import { ThreadHoverCard } from "./threadHoverCard";
import { useProjectSectionMenu } from "./projectSectionMenu";
import { gridHeadingMenuItems, hiddenGridIdFromAction } from "./gridHeadingMenu";
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
  shouldShowThreadJumpHintsForModifiers,
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
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { AnimatedHeight } from "../AnimatedHeight";
import { isAppModalPage } from "../sidebar/mainAppLocation";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarRailKbd, SidebarRailNav } from "../sidebar/SidebarRailNav";
import { useOpenPullRequestCount } from "../pullRequest/useOpenPullRequestCount";
import { useTaskYourTurnCount } from "../../state/tasks";
import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../sidebar/sidebarProviderEntries";
import {
  isTrailingDoubleClick,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
} from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
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
import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { MOTION_FEEDBACK, MOTION_FEEDBACK_OPACITY } from "../ui/motion-recipes";
import { shelfReturnAction } from "../../grid/shelfReturn";
import { olderSettledScopesForProjects } from "../../grid/olderSettledScopes";
import {
  clampSearchHighlight,
  contentOnlyMatches,
  moveSearchHighlight,
  orderSearchResults,
} from "../../grid/sidebarSearch";
import { useThreadSearch } from "../../state/queries";
import { findForMessageMatch, openThreadFindOnQuery } from "../chat/threadFindStore";
import {
  SidebarContentResults,
  SidebarNoSearchResults,
  SidebarSearchHighlightContext,
  useSearchHighlight,
  type ContentResult,
} from "./sidebarSearchResults";
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
  const openProjectGroups = orderSidebarProjectGroups(projectGroups);
  const storedFilterKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const setStoredFilterKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
  const filterKeys = activeProjectFilterKeys(openProjectGroups, storedFilterKeys);
  const orderedProjectGroups = applyProjectFilter(openProjectGroups, filterKeys);
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
  const [searchIndex, setSearchIndex] = useState(0);
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
  const railRef = useRef<HTMLDivElement | null>(null);

  const actions = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const openProjectMenu = useProjectSectionMenu();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const openThread = (gridId: string, threadId: string) => {
    // Opening a thread ends a multi-selection; its rows may be on other panes now.
    if (selection.selectedThreadKeys.size > 0) setSelection(clearThreadSelection());
    useGridStore.getState().focusThread(gridId, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId } });
  };

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentMachines = useEnvironmentMachines();
  // A selection made under one filter can hold threads the next filter hides.
  const changeProjectFilter = (keys: string[]) => {
    setSelection(clearThreadSelection());
    setStoredFilterKeys(keys);
  };
  const openProjectSettings = (group: SidebarProjectSnapshot) => {
    void navigate({
      to: "/settings/projects",
      search: { project: group.projectKey, machine: undefined },
    });
  };
  const threadProjectFilter = (workspace: { environmentId: string; projectId: string }) => {
    const group = openProjectGroups.find((candidate) =>
      groupContainsWorkspace(candidate, workspace),
    );
    if (group === undefined) return null;
    const isActive = filterKeys.includes(group.projectKey);
    return {
      label: group.displayName,
      isActive,
      onToggle: () => changeProjectFilter(isActive ? [] : [group.projectKey]),
    };
  };

  // Opening a thread the filter hides (history, a link, the palette) widens the
  // filter once, so the row the user navigated to is on the rail.
  const openWorkspaceKey = openGrid?.workspaceKey ?? null;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- widens the persisted project filter when navigation lands on a project the filter hides
  useEffect(() => {
    if (openWorkspaceKey === null || filterKeys.length === 0) return;
    const hidden = !orderedProjectGroups.some((group) =>
      group.memberProjectRefs.some(
        (ref) => workspaceKeyOf(ref.environmentId, ref.projectId) === openWorkspaceKey,
      ),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- the filter is persisted client state that navigation must be able to widen
    if (hidden) changeProjectFilter([]);
    // Only a change of the open workspace widens; choosing a filter while a thread is open keeps it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the filter and project list are read when the open workspace changes, not on every change of them
  }, [openWorkspaceKey]);

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
  // The first nine rows carry their Mod+1..9 label while the modifier is held.
  const shortcutModifiers = useShortcutModifierState();
  const jumpHintsVisible = useThreadJumpHintsVisible(
    shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
      context: { terminalFocus: isTerminalFocused() },
    }),
  );
  const jumpHints = jumpHintsVisible ? jumpHintLabels(orderedThreadKeys, keybindings) : null;
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
  const openShell = currentFocus === null ? undefined : threadById.get(currentFocus.threadId);
  useRevealOpenThread(
    railRef,
    openShell === undefined
      ? null
      : scopedThreadKey(scopeThreadRef(openShell.environmentId, openShell.id)),
  );

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
      reportFailure("Failed to rename thread", result);
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

  const openBulkMenu = useBulkThreadMenu({
    selectedThreads,
    nowIso,
    onClose: closeThreads,
    onHold: holdThreads,
    onDone: () => setSelection(clearThreadSelection()),
  });

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
    if (returnShelfThreadFromDrag(source)) return;
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
    if (returnShelfThreadFromDrag(source)) return;
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

  const wakeShelfThread = (thread: EnvironmentThreadShell, open = true) => {
    void (async () => {
      const result = await actions.unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to bring thread back", result) && open) openReturnedThread(thread);
    })();
  };

  const reopenShelfThread = (thread: EnvironmentThreadShell, open = true) => {
    void (async () => {
      const result = await actions.unsettleThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to reopen thread", result) && open) openReturnedThread(thread);
    })();
  };

  // A shelf row dropped into the rail returns to its grid without moving the user.
  const returnShelfThreadFromDrag = (source: DraggedThread) => {
    const thread = threadById.get(source.threadId);
    if (thread === undefined) return false;
    const action = shelfReturnAction(thread, nowIso);
    if (action === "wake") wakeShelfThread(thread, false);
    else if (action === "reopen") reopenShelfThread(thread, false);
    return action !== null;
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

  // A press-and-sweep across Close, Reopen or Wake buttons applies that action to every row swept.
  const rowSweep: RowActionSweep = (event, action, threadKey) =>
    beginRowActionSweep(event, {
      action,
      threadKey,
      apply: (swept, keys) => {
        const targets = keys.flatMap((key) =>
          threads.filter((thread) => threadKeyOf(thread) === key),
        );
        if (swept === "close") closeThreads(targets);
        else if (swept === "reopen") for (const thread of targets) reopenShelfThread(thread, false);
        else for (const thread of targets) wakeShelfThread(thread, false);
      },
    });
  const searching = query.length > 0;
  const heldShown = searching
    ? shelves.held.filter((thread) => threadMatchesGridSearch(thread, query))
    : shelves.held;
  const closedShown = searching
    ? shelves.closed.filter((thread) => threadMatchesGridSearch(thread, query))
    : shelves.closed;
  const threadKeyOf = (thread: { environmentId: string; id: string }) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId as EnvironmentId, thread.id as ThreadId));
  const messageSearch = useThreadSearch(
    [...new Set(projects.map((project) => project.environmentId))],
    query,
  );
  const titleResultThreads = [...searchMatchThreads, ...heldShown, ...closedShown];
  const contentMatches = searching
    ? contentOnlyMatches(messageSearch.matches, {
        keyOf: (match) => threadKeyOf({ environmentId: match.environmentId, id: match.threadId }),
        shownKeys: new Set(titleResultThreads.map(threadKeyOf)),
        isVisible: (match) =>
          threadById.has(match.threadId) &&
          workspaceKeys.has(workspaceKeyOf(match.environmentId, match.projectId)),
      })
    : [];
  // Opens a thread wherever it lives: in a grid, ungrouped, on hold or closed.
  const openFoundThread = (thread: EnvironmentThreadShell) => {
    const target = railTargets.find(
      (candidate) =>
        candidate.threadId === thread.id && candidate.environmentId === thread.environmentId,
    );
    if (target !== undefined) openRailTarget(target);
    else if (thread.settledOverride === "settled") reopenShelfThread(thread);
    else if (effectiveSnoozed(thread, { now: nowIso })) wakeShelfThread(thread);
    else openReturnedThread(thread);
  };
  const contentResults: ContentResult[] = contentMatches.flatMap((match) => {
    const thread = threadById.get(match.threadId);
    if (thread === undefined) return [];
    return [
      {
        key: threadKeyOf(thread),
        thread,
        snippet: match.snippet,
        onOpen: () => {
          openFoundThread(thread);
          openThreadFindOnQuery(
            threadKeyOf(thread),
            findForMessageMatch(match, messageSearch.query),
          );
        },
      },
    ];
  });
  const searchResultOrder = orderSearchResults(
    titleResultThreads.map(threadKeyOf),
    contentResults.map((result) => result.key),
  );
  const highlightedSearchKey = searching
    ? (searchResultOrder[clampSearchHighlight(searchIndex, searchResultOrder.length)] ?? null)
    : null;
  const openHighlightedSearchResult = () => {
    if (highlightedSearchKey === null) return false;
    const content = contentResults.find((result) => result.key === highlightedSearchKey);
    if (content !== undefined) {
      content.onOpen();
      return true;
    }
    const thread = titleResultThreads.find(
      (candidate) => threadKeyOf(candidate) === highlightedSearchKey,
    );
    if (thread === undefined) return false;
    openFoundThread(thread);
    return true;
  };

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
    <ProjectFilterContext.Provider value={threadProjectFilter}>
      <SidebarSearchHighlightContext.Provider value={highlightedSearchKey}>
        <RowActionSweepContext.Provider value={rowSweep}>
          <ThreadJumpHintContext.Provider value={jumpHints}>
            <ThreadBulkMenuContext.Provider
              value={
                selection.selectedThreadKeys.size > 1
                  ? (position) => void openBulkMenu(position)
                  : null
              }
            >
              <ThreadContextDragGhost />
              <SidebarChromeHeader isDesktopHost={isDesktopHost} />
              <SidebarHeader>
                <SidebarRailNav
                  pullRequestCount={pullRequestCount}
                  taskCount={taskCount}
                  sectionHeading={false}
                  search={
                    <label className="flex h-7 w-full shrink-0 items-center gap-2 rounded-(--control-radius) px-2 text-sm text-secondary-foreground hover:bg-sidebar-row-hover focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset">
                      <SearchIcon
                        aria-hidden
                        className="size-[15px] shrink-0 text-secondary-label"
                      />
                      <input
                        value={search}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setSearchIndex(0);
                        }}
                        onKeyDown={(event) => {
                          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && searching) {
                            event.preventDefault();
                            setSearchIndex(
                              moveSearchHighlight(
                                clampSearchHighlight(searchIndex, searchResultOrder.length),
                                searchResultOrder.length,
                                event.key === "ArrowDown" ? 1 : -1,
                              ),
                            );
                            return;
                          }
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setSearch("");
                          }
                          if (event.key === "Enter") {
                            if (openHighlightedSearchResult()) return;
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
                                void navigate({
                                  to: "/grid/$gridId",
                                  params: { gridId: matchedGrid.id },
                                });
                              return;
                            }
                            const matchedProject = projects.find((project) =>
                              project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                            );
                            const workspaceTarget =
                              matchedProject === undefined
                                ? undefined
                                : railTargets.find(
                                    (target) =>
                                      target.environmentId === matchedProject.environmentId,
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
                <div
                  ref={(element) => {
                    railRef.current = element;
                    return attachSidebarTree(element);
                  }}
                  className="flex min-h-full flex-col px-2 pb-2"
                >
                  <SidebarProjectsHeader
                    options={sidebarOptions}
                    onChange={(patch) => void updateClientSettings(sidebarOptionsPatch(patch))}
                    onReset={() => void updateClientSettings(SIDEBAR_OPTIONS_DEFAULTS)}
                    hiddenGridGroups={hiddenGridGroups}
                    projectFilter={
                      openProjectGroups.length > 1 ? (
                        <ProjectFilterPicker
                          groups={openProjectGroups}
                          activeKeys={filterKeys}
                          primaryEnvironmentId={primaryEnvironmentId}
                          machineByEnvironmentId={environmentMachines}
                          onChange={changeProjectFilter}
                          onOpenSettings={openProjectSettings}
                        />
                      ) : null
                    }
                  />
                  <div className="flex flex-col gap-px">
                    {sections.length === 0 && query.length === 0 ? <SidebarNoProjects /> : null}
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
                          providerEntriesByEnvironment.get(section.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        nowIso={nowIso}
                        selection={selection}
                        runningSubagents={runningSubagentsByThread}
                        dragging={dragging}
                        dropTarget={dropTarget}
                        onOpenThread={openThread}
                        onSelectThread={selectThread}
                        onCloseThread={(thread) => closeThreads([thread])}
                        onHoldThread={(thread, preset) =>
                          holdThreads([thread], preset.snoozedUntil)
                        }
                        onPickHoldTime={pickHoldTime}
                        onDropOnGrid={(source, targetGridId) =>
                          moveThreadToGrid(source, targetGridId)
                        }
                        onDropOnThread={dropThreadOnThread}
                        onCreateGrid={() =>
                          createGridInWorkspace(
                            workspaceKeyOf(section.environmentId, section.projectId),
                          )
                        }
                        onOpenProjectMenu={(position) => {
                          const group = projectGroups.find(
                            (candidate) => candidate.projectKey === section.projectKey,
                          );
                          if (group === undefined) return;
                          void openProjectMenu(group, position, () =>
                            createGridInWorkspace(
                              workspaceKeyOf(section.environmentId, section.projectId),
                            ),
                          );
                        }}
                        onCreateThread={(gridId) => {
                          const grid = gridById(grids, gridId);
                          if (grid !== null) createThreadInGrid(grid);
                        }}
                        onRenameThread={renameThread}
                        onSetAutoClose={setAutoClose}
                        handleNewThread={handleNewThread}
                        onShowGrid={(gridId) =>
                          useGridStore.getState().setGridHidden(gridId, false)
                        }
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
                    {searching ? <SidebarContentResults results={contentResults} /> : null}
                    {searching &&
                    sections.length === 0 &&
                    titleResultThreads.length === 0 &&
                    contentResults.length === 0 &&
                    !messageSearch.isPending ? (
                      <SidebarNoSearchResults query={query} />
                    ) : null}
                  </div>
                </div>
              </SidebarContent>
              <div
                ref={attachSidebarTree}
                className="shrink-0 px-2 pt-1 pb-1"
                data-testid="grid-shelves-pin"
              >
                <Separator className="mb-1" data-shelves-rule="" />
                <GridShelves
                  held={heldShown}
                  closed={closedShown}
                  forceExpanded={searching}
                  older={{
                    scopes: olderSettledScopesForProjects(projects),
                    threads: threads.filter((thread) =>
                      workspaceKeys.has(workspaceKeyOf(thread.environmentId, thread.projectId)),
                    ),
                  }}
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
                      query={query}
                      providerEntries={
                        providerEntriesByEnvironment.get(thread.environmentId) ??
                        EMPTY_PROVIDER_ENTRIES
                      }
                      nowIso={nowIso}
                      focused={false}
                      selected={selection.selectedThreadKeys.has(
                        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                      )}
                      dragging={false}
                      runningSubagents={
                        runningSubagentsByThread.get(subagentParentKey(thread)) ?? 0
                      }
                      workspaceTitle={
                        workspaceTitles.get(
                          workspaceKeyOf(thread.environmentId, thread.projectId),
                        ) ?? ""
                      }
                      timeLabel={
                        shelf === "snoozed" && thread.snoozedUntil !== null
                          ? formatUpcomingTimestamp(thread.snoozedUntil, timestampFormat)
                          : shelf === "settled"
                            ? closedAgeLabel(thread, Date.parse(`${nowMinute}:00.000Z`))
                            : null
                      }
                      shelf={shelf}
                      onOpen={() => {
                        if (shelf === "snoozed") wakeShelfThread(thread);
                        else reopenShelfThread(thread);
                      }}
                      onSelect={(input) => selectThread(thread, input)}
                      onClose={() => closeThreads([thread])}
                      onHold={(preset) => holdThreads([thread], preset.snoozedUntil)}
                      onPickHoldTime={pickHoldTime}
                      onRename={(title) => renameThread(thread, title)}
                      onSetAutoClose={(enabled) => setAutoClose(thread, enabled)}
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
                              if (picked !== null)
                                holdThreads(selectedThreads, picked.snoozedUntil);
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
            </ThreadBulkMenuContext.Provider>
          </ThreadJumpHintContext.Provider>
        </RowActionSweepContext.Provider>
      </SidebarSearchHighlightContext.Provider>
    </ProjectFilterContext.Provider>
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
  projectFilter = null,
}: {
  options: SidebarGridOptions;
  onChange: (patch: Partial<SidebarGridOptions>) => void;
  onReset: () => void;
  hiddenGridGroups?: ReadonlyArray<{
    workspaceKey: string;
    title: string;
    grids: ReadonlyArray<GridRecord>;
  }>;
  /** The project filter picker, when there is more than one project to choose from. */
  projectFilter?: ReactNode;
}) {
  return (
    <SidebarSectionHeaderRow
      title="Projects"
      actions={
        <>
          {projectFilter}
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

function projectRowId(section: Pick<SidebarProjectSectionModel, "environmentId" | "projectId">) {
  return `project:${workspaceKeyOf(section.environmentId, section.projectId)}`;
}

function gridRowId(grid: Pick<GridRecord, "id">) {
  return `grid:${grid.id}`;
}

/** A project's grids, then the threads no grid shows, under one collapsible label. */
export function SidebarProjectSection({
  section,
  query,
  openGridId,
  collapsed: collapsedPreference,
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
  // A search shows every match, so it opens a project the user collapsed.
  const collapsed = query.length === 0 && collapsedPreference;
  const projectMenu = section.isScratch ? undefined : onOpenProjectMenu;
  const revealed = collapsed ? revealedOpenThread(section.grids, openGridId) : null;
  const hiddenThreads = collapsed
    ? [...section.grids.flatMap((entry) => entry.threads), ...section.ungroupedThreads].filter(
        (thread) => thread.id !== revealed?.thread.id,
      )
    : [];
  const rollup = collapsedRollup(hiddenThreads);

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
                data-sidebar-row={projectRowId(section)}
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
                className={cn(SIDEBAR_PROJECT_LABEL_CLS, projectMenu !== undefined && "pr-14")}
              >
                {collapsed ? (
                  <FolderIcon aria-hidden className={SIDEBAR_PROJECT_ICON_CLS} />
                ) : (
                  <FolderOpenIcon aria-hidden className={SIDEBAR_PROJECT_ICON_CLS} />
                )}
                <span className={SIDEBAR_PROJECT_LABEL_TEXT_CLS}>{section.title}</span>
                {collapsed && rollup.dot !== null ? (
                  <SidebarStatusGlyph state={rollup.dot.state} label={rollup.dot.label} />
                ) : null}
                {collapsed && rollup.count > 0 ? (
                  <span className={SIDEBAR_PROJECT_SUMMARY_CLS}>{rollup.count}</span>
                ) : null}
              </button>
            }
          />
          <TooltipPopup side="bottom" align="start">
            {section.title}
          </TooltipPopup>
        </Tooltip>
        {section.isScratch ? null : (
          <span className="absolute inset-y-0 right-1 flex items-center gap-0.5">
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
            {projectMenu === undefined ? null : (
              <button
                type="button"
                aria-label={`Project actions for ${section.title}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  projectMenu({ x: rect.left, y: rect.bottom + 4 });
                }}
                className={SIDEBAR_PROJECT_ACTION_CLS}
              >
                <MoreHorizontalIcon aria-hidden className="size-3.5" />
              </button>
            )}
          </span>
        )}
      </div>
      <AnimatedHeight>
        {collapsed ? (
          revealed === null ? null : (
            <div className="flex flex-col gap-px">
              <ThreadCard
                key={revealed.thread.id}
                gridId={revealed.grid.id}
                thread={revealed.thread}
                query={query}
                providerEntries={providerEntries}
                nowIso={nowIso}
                focused
                selected={selection.selectedThreadKeys.has(
                  scopedThreadKey(
                    scopeThreadRef(revealed.thread.environmentId, revealed.thread.id),
                  ),
                )}
                dragging={dragging?.threadId === revealed.thread.id}
                runningSubagents={runningSubagents.get(subagentParentKey(revealed.thread)) ?? 0}
                workspaceTitle={section.title}
                treeParent={gridRowId(revealed.grid)}
                onOpen={() => onOpenThread(revealed.grid.id, revealed.thread.id)}
                onSelect={(input) => onSelectThread(revealed.thread, input)}
                onClose={() => onCloseThread(revealed.thread)}
                onHold={(preset) => onHoldThread(revealed.thread, preset)}
                onPickHoldTime={onPickHoldTime}
                onRename={(title) => onRenameThread(revealed.thread, title)}
                onSetAutoClose={(enabled) => onSetAutoClose(revealed.thread, enabled)}
                onDropOnThread={(source) =>
                  onDropOnThread(source, revealed.grid.id, revealed.thread.id)
                }
                onOpenGrid={(targetGridId) => onOpenThread(targetGridId, revealed.thread.id)}
                handleNewThread={handleNewThread}
              />
            </div>
          )
        ) : (
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
                treeParent={projectRowId(section)}
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
  const revealedThread =
    collapsed && open ? threads.find((thread) => thread.id === grid.focusedThreadId) : undefined;
  const gridRollup = collapsedRollup(
    collapsed ? threads.filter((thread) => thread.id !== revealedThread?.id) : [],
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

  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openGridMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items = gridHeadingMenuItems({
      pinned: grid.pinnedAt !== null,
      manualOrder,
      readyCount: readyThreads.length,
      workspaceTitle,
      hiddenGrids,
    });
    setMenuOpen(true);
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    setMenuOpen(false);
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const action = clicked.value;
    const hiddenGridId = hiddenGridIdFromAction(action);
    if (hiddenGridId !== null) {
      onShowGrid(hiddenGridId);
      return;
    }
    switch (action) {
      case "new-thread":
        onCreateThread();
        return;
      case "rename":
        startRenaming();
        return;
      case "toggle-pin":
        if (grid.pinnedAt === null) pinGrid(grid.id);
        else unpinGrid(grid.id);
        return;
      case "move-up":
        moveGridInWorkspace(grid.id, -1);
        return;
      case "move-down":
        moveGridInWorkspace(grid.id, 1);
        return;
      case "hide":
        setGridHidden(grid.id, true);
        return;
      case "delete":
        await deleteGridWithConfirm(grid, deleteGrid);
        return;
      case "close-ready":
        closeAllReady();
        return;
      case "new-grid":
        onCreateGrid();
        return;
    }
  };
  const openGridMenuBelow = (element: HTMLElement | null) => {
    const rect = element?.getBoundingClientRect();
    if (rect === undefined) return;
    void openGridMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <div className="mt-1 flex flex-col gap-px" data-grid-key={grid.id}>
      <div
        ref={headerRef}
        className="group/grid relative flex items-center"
        onContextMenu={(event) => {
          if (renaming) return;
          event.preventDefault();
          void openGridMenu({ x: event.clientX, y: event.clientY });
        }}
      >
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
                  data-sidebar-row={gridRowId(grid)}
                  data-sidebar-parent={`project:${grid.workspaceKey}`}
                  onClick={onToggleCollapsed}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      startRenaming();
                      return;
                    }
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      openGridMenuBelow(event.currentTarget);
                    }
                  }}
                  aria-expanded={!collapsed}
                  className={cn(
                    SIDEBAR_GRID_HEADING_CLS,
                    // One selection fill at a time: the focused thread row carries it while visible.
                    open &&
                      revealedThread === undefined &&
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
                    <>
                      {gridRollup.dot === null ? null : (
                        <SidebarStatusGlyph
                          state={gridRollup.dot.state}
                          label={gridRollup.dot.label}
                        />
                      )}
                      {gridRollup.count > 0 ? (
                        <span className={SIDEBAR_GRID_COUNT_CLS}>{gridRollup.count}</span>
                      ) : null}
                    </>
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
            <button
              ref={actionsButtonRef}
              type="button"
              aria-label={`Grid actions for ${grid.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => openGridMenuBelow(actionsButtonRef.current)}
              className={cn(
                SIDEBAR_GRID_ACTION_CLS,
                "absolute right-1 top-1/2 -translate-y-1/2",
                menuOpen && "opacity-100",
              )}
            >
              <MoreHorizontalIcon aria-hidden className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <AnimatedHeight>
        {collapsed && revealedThread === undefined ? null : (
          <div className="flex flex-col gap-px">
            {(revealedThread === undefined ? threads : [revealedThread]).map((thread) => (
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
                treeParent={gridRowId(grid)}
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

// Positioned so the actions paint above the faded time; out of flow until the row is hovered or focused.
const ROW_ACTIONS_IN_FLOW = "relative";
const ROW_ACTIONS_OUT_OF_FLOW =
  "absolute top-0 right-0 group-hover/th:relative group-has-[:focus-visible]/th:relative";

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
  /** The row id of the grid or project this row sits under, for arrow-key navigation. */
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
  onDropOnThread: (source: DraggedThread) => void;
  /** Opens the grid a menu move landed in; absent hides the Move to grid submenu. */
  onOpenGrid?: ((gridId: string) => void) | undefined;
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
  const branchName = useThreadBranchName(thread);
  const showPullRequest = useClientSettings((settings) => settings.sidebarRowShowPullRequest);
  const showSubagents = useClientSettings((settings) => settings.sidebarRowShowSubagents);
  const state = resolveGridThreadState(thread, nowIso);
  const attention = state === "needs" || state === "ready" || state === "back";
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
    grid: {
      currentGridId: gridId,
      isFocusedCell: focused,
      onOpen,
      ...(onOpenGrid === undefined ? {} : { onOpenGrid }),
    },
    onCloseThread: onClose,
    onHoldThread: (snoozedUntil) => onHold({ snoozedUntil }),
    onSetAutoSettle: onSetAutoClose,
    onReopenThread: onReopen,
    onWakeThread: onWake,
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
    if (renaming) return;
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
      title: thread.title,
    });
  };
  useThreadDropZone(
    rowRef,
    (_point, source) =>
      shelf === null && gridId !== null && source.threadId !== thread.id
        ? { kind: "thread", gridId, threadId: thread.id }
        : null,
    (source) => onDropOnThread(source),
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
            className={cn(
              `group/th relative flex w-full flex-col gap-1 rounded-lg py-2 pr-2.5 text-left outline-none ${MOTION_FEEDBACK} ${FOCUS_ROW_CLS}`,
              notInGrid ? "pl-2" : "pl-7.5",
              "cursor-pointer",
              dragging && "opacity-50",
              fileDrop.over && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
              selected
                ? "bg-(--row-current)"
                : searchHighlight.highlighted
                  ? "bg-(--sidebar-row-active)"
                  : focused
                    ? "bg-(--sidebar-row-active)"
                    : "hover:bg-(--sidebar-row-hover)",
            )}
          />
        }
      >
        <div className="flex min-h-[22px] min-w-0 items-center gap-2">
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
                  onSelect({ shiftKey: event.shiftKey, toggleKey: event.metaKey || event.ctrlKey });
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
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-headline leading-4.75 text-foreground",
                  attention ? "font-semibold" : "font-medium",
                  regeneratingTitle && "opacity-55",
                )}
              >
                <HighlightedText text={thread.title} query={query} />
              </span>
            </button>
          )}
          {/*
            The time and the hover actions share one grid cell. Hidden actions leave the flow, so a
            resting title runs up to the time; shown, they join it and the title truncates before them.
          */}
          <span className="relative grid min-h-[22px] shrink-0 items-center justify-items-end">
            <span
              className={cn(
                "col-start-1 row-start-1",
                ROW_STATUS_RECEDE,
                MOTION_FEEDBACK_OPACITY,
                actionsVisible && ROW_STATUS_HIDDEN,
              )}
            >
              {jumpHint === null ? (
                <span className="text-xs text-secondary-label tabular-nums">
                  {timeLabel ?? threadTimeLabel(thread, nowMinute)}
                </span>
              ) : (
                <JumpHintBadge label={jumpHint} />
              )}
            </span>
            <span
              className={cn(
                "col-start-1 row-start-1 flex h-[22px] items-center gap-0.5",
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
                  className={cn(
                    "inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground data-sweep-hit:bg-(--sel) hover:bg-(--sel) hover:text-foreground",
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
                  {canHold ? (
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
                  ) : null}
                  <button
                    type="button"
                    aria-label="Close thread"
                    {...sweepActionProps("close")}
                    onPointerDown={(event) => sweep?.(event, "close", threadKey)}
                    onClick={close}
                    className={cn(
                      "inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-(--r-badge) px-1.5 text-xs text-secondary-foreground data-sweep-hit:bg-(--sel) hover:bg-(--sel) hover:text-foreground",
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
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-caption leading-3.75 text-secondary-label">
          {showBranch ? (
            <>
              <ThreadCheckoutMark thread={thread} />
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
          <ThreadRowIndicators
            thread={thread}
            rowRef={rowRef}
            focused={focused}
            onActivate={onOpen}
          />
          {showSubagents && runningSubagents > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
              <UsersIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">
                {runningSubagents === 1
                  ? "1 subagent running"
                  : `${runningSubagents} subagents running`}
              </span>
            </span>
          ) : null}
          {showPullRequest && rowPullRequest !== null ? (
            <ThreadRowPullRequestBadge
              threadRef={threadRef}
              pullRequest={rowPullRequest}
              pullRequestCount={thread.pullRequests.length}
              onOpenThread={onOpen}
            />
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
            <ThreadStateMark thread={thread} state={state} nowIso={nowIso} />
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
        <ThreadHoverCard
          thread={thread}
          workspaceTitle={workspaceTitle}
          providerEntries={providerEntries}
          branchName={branchName}
          nowMs={Date.parse(`${nowMinute}:00.000Z`)}
        />
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
