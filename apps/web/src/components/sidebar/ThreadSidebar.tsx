import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@houston-app/client-runtime/state/runtime";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { useNavigate, useRouter, useLocation } from "@tanstack/react-router";
import { projectKeyOf } from "@houston-app/shared/projectKey";
import {
  ChevronRightIcon,
  EyeOffIcon,
  FolderPlusIcon,
  SquarePenIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { openThreadInLayout } from "../../threads/openThreadInLayout";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { requestConfirmDialog } from "../../confirmDialog";
import { openAddProjectDialog } from "../AddProjectDialog";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { isDesktopHost } from "../../env";
import { DEFAULT_SIDEBAR_GRID_THREAD_SORT_ORDER } from "@houston-app/contracts/settings";
import { selectFocusedTab, type LayoutWorkspace } from "../../layout/layoutModel";
import { chatTargetThreadRef } from "../../layout/layoutThreadRef";
import { useLayoutStore } from "../../layout/layoutStore";
import { useThreadMembershipStore } from "../../layout/threadMembership";
import {
  createLayoutWorkspaceAction,
  deleteLayoutWorkspaceAction,
  hideLayoutWorkspaceAction,
  openLayoutLauncherInWorkspaceAction,
  pinLayoutWorkspaceAction,
  renameLayoutWorkspaceAction,
  reorderLayoutWorkspaceAction,
} from "../../layout/layoutWorkspaceActions";
import { useLayoutTabLabel } from "../../layout/useLayoutTabLabel";
import { nextRailTargetIndex } from "../../threads/rail";
import {
  dragSourceWorkspaceId,
  isTabDragSource,
  useThreadDragSource,
  type ThreadDragSource,
  useThreadDropTarget,
  useThreadDropZone,
  type WorkspaceDragSource,
} from "../../threads/threadDrag";
import {
  NEW_WORKSPACE_DROP,
  WORKSPACE_SPRING_LOAD_MS,
  resolveWorkspaceDrop,
} from "../../threads/workspaceDrop";
import { moveTabToWorkspaceDrop } from "../../layout/workspaceTabDrop";
import { SidebarNewWorkspaceDropZone } from "./SidebarNewWorkspaceDropZone";
import { useDragAutoScroll } from "./useDragAutoScroll";
import {
  attentionCardsForWorkspaces,
  clearThreadSelection,
  nextAttentionCard,
  partitionShelfThreads,
  resolveThreadRowState,
  runningSubagentsByParentThread,
  subagentParentKey,
  updateThreadSelection,
  type ThreadSelection,
} from "../../threads/sidebarModel";
import { closedAgeLabel } from "../../threads/statusWord";
import {
  activeProjectFilterKeys,
  applyProjectFilter,
  groupContainsWorkspace,
  orderSidebarProjectGroups,
} from "../../threads/projectFilter";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectFilterContext, ProjectFilterPicker } from "./ProjectFilterPicker";
import { jumpHintLabels } from "../../threads/jumpHints";
import { useRevealOpenThread } from "../../threads/useRevealOpenThread";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { reportFailure } from "./reportFailure";
import { SidebarNoProjects } from "./SidebarNoProjects";
import { ThreadBulkMenuContext, useBulkThreadMenu } from "./useBulkThreadMenu";
import { ThreadJumpHintContext } from "./threadJumpHints";
import { SidebarShelves } from "./SidebarShelves";
import { readLocalApi } from "../../localApi";
import { useIsPhone } from "../../mobile/usePhone";
import { ThreadContextDragGhost } from "../chat/ThreadContextDragGhost";
import { RowActionSweepContext, type RowActionSweep } from "./rowActionSweepContext";
import { beginRowActionSweep } from "../../threads/rowActionSweep";
import { COLLAPSED_WORKSPACES_STORAGE_KEY, useCollapsedKeys } from "./sidebarCollapse";
import { hiddenWorkspaceIdFromAction, workspaceHeadingMenuItems } from "./workspaceHeadingMenu";
import {
  buildSidebarWorkspaceSections,
  createSidebarRowOrderMemory,
  type SidebarWorkspaceSection,
} from "./sidebarWorkspaceSections";
import { moveThreadToWorkspaceWithFeedback } from "./workspaceMoveFeedback";
import { planForeignThreadAssignments } from "./foreignThreadMembership";
import { assignThreadWorkspace } from "../../layout/threadWorkspaceCommands";
import { layoutEnvironmentId } from "../../layout/layoutSyncRuntime";
import {
  deleteWorkspaceThreads,
  planWorkspaceDeletion,
  workspaceDeletionMessage,
} from "./workspaceDeletion";
import type { NeedsYouEntry } from "./needsYouSection";
import { buildNeedsYouEntries, isNeedsYouThread } from "./needsYouSection";
import {
  WORKSPACE_REORDER_ATTRIBUTE,
  useWorkspaceReorderDrag,
  type WorkspaceReorderDrag,
} from "./workspaceReorderDrag";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { registerSettleAndAdvance } from "../../settleAndAdvance";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useThreadActions } from "../../hooks/useThreadActions";
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
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { AnimatedHeight } from "../AnimatedHeight";
import { isAppModalPage } from "./mainAppLocation";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { openCommandPalette } from "../../commandPaletteBus";
import { SidebarRailNav } from "./SidebarRailNav";
import type { SidebarProviderEntry } from "./SidebarThreadRow";
import { EMPTY_PROVIDER_ENTRIES, sidebarProviderEntriesAtom } from "./sidebarProviderEntries";
import { useSnoozeWakeClock, useThreadJumpHintsVisible } from "../Sidebar.logic";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarHeader, useSidebar, useSidebarVisibility } from "../ui/sidebar";
import { ThreadCard, HighlightedText } from "./ThreadCard";
import type { ThreadActionMenuWorkspaceInput } from "../../hooks/useThreadActionMenu";
import {
  SIDEBAR_EMPTY_ACTION_CLS,
  SIDEBAR_GROUP_ACTION_CLS,
  SIDEBAR_GROUP_CHEVRON_BOX_CLS,
  SIDEBAR_GROUP_CHEVRON_CLS,
  SIDEBAR_GROUP_CHEVRON_EXPANDED_CLS,
  SIDEBAR_GROUP_COUNT_CLS,
  SIDEBAR_GROUP_EMPTY_CLS,
  SIDEBAR_GROUP_HEADING_CLS,
  SIDEBAR_GROUP_HEADING_DROP_CLS,
  SIDEBAR_GROUP_SECTION_DROP_CLS,
  SIDEBAR_GROUP_HEADING_ROW_CLS,
  SIDEBAR_GROUP_RENAME_CLS,
  SIDEBAR_NEEDS_YOU_DOT_CLS,
  SIDEBAR_NEEDS_YOU_HEADING_CLS,
  SIDEBAR_NEEDS_YOU_HEADING_GLYPH_CLS,
  SIDEBAR_NEEDS_YOU_SECTION_CLS,
  SIDEBAR_ROW_ACTIONS_CLS,
  SIDEBAR_ROW_TRAILING_CLS,
  SIDEBAR_SECTION_ACTION_CLS,
  SIDEBAR_TOOLBAR_ACTION_CLS,
  SidebarOptionsMenu,
  SidebarSectionHeaderRow,
  SIDEBAR_GROUP_THREADS_CLS,
  sidebarGroupNameCls,
  type SidebarMenuOptions,
} from "../ui/sidebar-sections";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SidebarContentResults,
  SidebarNoSearchResults,
  SidebarSearchHighlightContext,
  type ContentResult,
} from "./sidebarSearchResults";
import {
  clampSearchHighlight,
  contentOnlyMatches,
  moveSearchHighlight,
  orderSearchResults,
} from "../../threads/sidebarSearch";
import { shelfReturnAction } from "../../threads/shelfReturn";
import { olderSettledScopesForProjects } from "../../threads/olderSettledScopes";
import { useThreadSearch } from "../../state/queries";
import { findForMessageMatch, openThreadFindOnQuery } from "../chat/threadFindStore";
import { parseThreadRoutePathname } from "../../threadRoutes";

type DraggedThread = WorkspaceDragSource;

function explain(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

export function ThreadSidebar({
  isPage = false,
}: {
  /** The rail stands alone as a page, without the controls of the docked column. */
  isPage?: boolean;
} = {}) {
  const allProjects = useProjects();
  const threads = useQuietThreadShells();
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
  const layout = useLayoutStore((store) => store.layout);
  const memberships = useThreadMembershipStore((store) => store);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadSort = useClientSettings((settings) => settings.sidebarGridThreadSortOrder);
  const showBranch = useClientSettings((settings) => settings.sidebarRowShowBranch);
  const showPullRequest = useClientSettings((settings) => settings.sidebarRowShowPullRequest);
  const showSubagents = useClientSettings((settings) => settings.sidebarRowShowSubagents);
  const isPhone = useIsPhone();
  const showNeedsYouChoice = useClientSettings((settings) => settings.sidebarShowNeedsYou);
  // Unset follows the device: the phone home shows Needs you, the desktop rail does not.
  const showNeedsYou = showNeedsYouChoice ?? isPhone;
  const sidebarOptions: SidebarMenuOptions = {
    threadSort,
    showBranch,
    showPullRequest,
    showSubagents,
    showNeedsYou,
  };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const sidebarVisible = useSidebarVisibility();
  const { isMobile: sidebarIsDrawer, setOpenMobile: setSidebarDrawerOpen } = useSidebar();
  // The rail mounts when the drawer opens, so only a change of page closes it, never the mount.
  const drawerPathnameRef = useRef(pathname);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- the route is external state; the drawer must follow a navigation made from anywhere (row, shortcut, link)
  useEffect(() => {
    if (drawerPathnameRef.current === pathname) return;
    drawerPathnameRef.current = pathname;
    if (sidebarIsDrawer) setSidebarDrawerOpen(false);
  }, [pathname, sidebarIsDrawer, setSidebarDrawerOpen]);
  const nowMinute = useNowMinute();
  const wakeClock = useSnoozeWakeClock(threads);
  const nowIso = new Date(wakeClock).toISOString();

  const [search, setSearch] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [selection, setSelection] = useState<ThreadSelection>(clearThreadSelection);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [rowOrder] = useState(createSidebarRowOrderMemory);
  const collapsedWorkspaces = useCollapsedKeys(COLLAPSED_WORKSPACES_STORAGE_KEY);
  const dragging = useThreadDragSource();
  const closedShelfIsDropTarget = useThreadDropTarget()?.kind === "closed";
  const railRef = useRef<HTMLDivElement | null>(null);
  useDragAutoScroll(railRef);

  const actions = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  // Each foreign thread is asked for once; a refused ask is retried on the next load, not in a loop.
  const askedForeignThreads = useRef(new Set<string>());
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- threads of other environments are hosted outside the layout server, so the window reports their workspace to it
  useEffect(() => {
    const pending = planForeignThreadAssignments({
      threads,
      memberships,
      layout,
      layoutEnvironmentId: layoutEnvironmentId(),
    }).filter(
      (entry) => !askedForeignThreads.current.has(`${entry.environmentId}:${entry.threadId}`),
    );
    for (const entry of pending) {
      askedForeignThreads.current.add(`${entry.environmentId}:${entry.threadId}`);
      void assignThreadWorkspace(entry, entry.workspaceId).catch(() => {
        askedForeignThreads.current.delete(`${entry.environmentId}:${entry.threadId}`);
      });
    }
  }, [threads, memberships, layout]);
  const deleteWorkspaceAndThreads = async (section: SidebarWorkspaceSection) => {
    const plan = planWorkspaceDeletion({
      workspaceId: section.workspaceId,
      memberships,
      threads,
      nowIso,
    });
    // An empty workspace has nothing to lose, so it goes without asking.
    if (plan.threads.length > 0) {
      const confirmed =
        (await requestConfirmDialog(workspaceDeletionMessage(section.name, plan), {
          variant: "destructive",
          confirmLabel: "Delete workspace",
        })) ?? false;
      if (!confirmed) return;
      const failure = await deleteWorkspaceThreads({
        workspaceName: section.name,
        plan,
        deleteThread: async (thread, deletedThreadKeys) => {
          const result = await actions.deleteThread(
            scopeThreadRef(thread.environmentId, thread.id),
            {
              deletedThreadKeys,
            },
          );
          if (result === null || result._tag === "Success") return null;
          const error = squashAtomCommandFailure(result);
          return error instanceof Error ? error.message : String(error);
        },
      });
      if (failure !== null) {
        explain("Could not delete workspace", failure);
        return;
      }
    }
    const refusal = deleteLayoutWorkspaceAction(
      section.workspaceId,
      new Set(plan.threads.map(threadKeyOf)),
    );
    if (refusal !== null) explain("Could not delete workspace", refusal);
  };
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const openThread = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => {
    // Opening a thread ends a multi-selection; its rows may be on other panes now.
    if (selection.selectedThreadKeys.size > 0) setSelection(clearThreadSelection());
    void openThreadInLayout(
      {
        navigate: (options) => navigate(options),
        pathname: () => router.state.location.pathname,
      },
      scopeThreadRef(thread.environmentId, thread.id),
    );
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

  const threadById = new Map<string, EnvironmentThreadShell>(
    threads.map((thread) => [thread.id, thread] as const),
  );
  const threadKeyOf = (thread: { environmentId: string; id: string }) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId as never, thread.id as never));

  // The thread behind the focused tab: its chat, or the thread a surface tab belongs to.
  const focusedContent = selectFocusedTab(layout)?.content;
  const focusedThreadRef =
    focusedContent?.kind === "chat"
      ? chatTargetThreadRef(focusedContent.target)
      : focusedContent?.kind === "surface"
        ? focusedContent.threadRef
        : null;
  const focusedThreadKey = focusedThreadRef === null ? null : scopedThreadKey(focusedThreadRef);
  const focusedShell =
    focusedThreadRef === null ? undefined : threadById.get(focusedThreadRef.threadId);
  const currentFocus = focusedShell === undefined ? null : { threadId: focusedShell.id };
  // A thread opened on its own route (a link, a reload) can have no tab yet; its route names it.
  const routeRef = focusedShell === undefined ? parseThreadRoutePathname(pathname) : null;
  const routeShell = routeRef === null ? undefined : threadById.get(routeRef.threadId);
  const revealShell =
    focusedShell ??
    (routeShell?.environmentId === routeRef?.environmentId ? routeShell : undefined);
  useRevealOpenThread(railRef, revealShell === undefined ? null : threadKeyOf(revealShell));

  // Opening a thread the filter hides (history, a link, the palette) widens the filter once, so
  // the row the user navigated to is on the rail.
  const openProjectKey =
    revealShell === undefined
      ? null
      : projectKeyOf(revealShell.environmentId, revealShell.projectId);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- widens the persisted project filter when navigation lands on a project the filter hides
  useEffect(() => {
    if (openProjectKey === null || filterKeys.length === 0) return;
    const hidden = !orderedProjectGroups.some((group) =>
      group.memberProjectRefs.some(
        (ref) => projectKeyOf(ref.environmentId, ref.projectId) === openProjectKey,
      ),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- the filter is persisted client state that navigation must be able to widen
    if (hidden) changeProjectFilter([]);
    // Only a change of the open project widens; choosing a filter while a thread is open keeps it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the filter and project list are read when the open project changes, not on every change of them
  }, [openProjectKey]);

  const projectKeys = new Set(
    projects.map((project) => projectKeyOf(project.environmentId, project.id)),
  );
  const projectTitles = new Map(
    projects.map((project) => [projectKeyOf(project.environmentId, project.id), project.title]),
  );
  const projectTitleOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    projectTitles.get(projectKeyOf(thread.environmentId, thread.projectId)) ??
    (thread.projectId.length === 0 ? "No project" : thread.projectId);

  const tabLabel = useLayoutTabLabel();
  const resolveWorkspaceTitle = (workspace: LayoutWorkspace) => {
    const lead = workspace.columns[0]?.panes[0]?.tabs[0];
    return lead ? tabLabel(lead).title : null;
  };

  const needsYouEntries = showNeedsYou
    ? buildNeedsYouEntries({ threads, nowIso, projectKeys })
    : [];
  const needsYouThreadIds = new Set(needsYouEntries.map((entry) => entry.thread.id));

  const query = search.trim();
  const searching = query.length > 0;
  const sectionInput = {
    layout,
    memberships,
    threads,
    threadSort,
    nowIso,
    projectKeys,
    resolveWorkspaceTitle,
    rowOrder,
  } as const;
  // Everything the rail can reach, whatever it draws now: keyboard traversal, attention and
  // jump hints follow the rows, not the search or the Needs you lift.
  const everything = buildSidebarWorkspaceSections({
    ...sectionInput,
    query: "",
    excludedThreadIds: undefined,
  });
  const { sections, hiddenSections } = buildSidebarWorkspaceSections({
    ...sectionInput,
    query,
    excludedThreadIds: showNeedsYou ? needsYouThreadIds : undefined,
  });

  const workspaceNames = new Map(
    [...everything.sections, ...everything.hiddenSections].map((section) => [
      section.workspaceId,
      section.name,
    ]),
  );
  const railTargets = everything.sections.flatMap((section) =>
    section.threads.map((thread) => ({
      workspaceId: section.workspaceId,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
    })),
  );
  const orderedThreadKeys = railTargets.map((target) =>
    scopedThreadKey(scopeThreadRef(target.environmentId, target.threadId as never)),
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
    const thread = threadById.get(target.threadId);
    if (thread !== undefined) openThread(thread);
  };

  // Hidden workspaces still answer Ctrl .: their threads keep their place.
  const allCards = attentionCardsForWorkspaces(
    [...everything.sections, ...everything.hiddenSections],
    nowIso,
  );

  const removeFromSelection = (threadsToRemove: ReadonlyArray<EnvironmentThreadShell>) => {
    const keys = new Set(threadsToRemove.map(threadKeyOf));
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
    const closedIds = new Set<string>(threadsToClose.map((thread) => thread.id));
    if (currentFocus !== null && closedIds.has(currentFocus.threadId)) {
      // Closing the open thread moves to the next row of its workspace.
      const section = everything.sections.find((candidate) =>
        candidate.threads.some((thread) => thread.id === currentFocus.threadId),
      );
      const next = section?.threads.find((thread) => !closedIds.has(thread.id));
      if (next !== undefined) openThread(next);
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
        context: { terminalFocus: false, editableFocus: false },
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
      if (thread !== undefined) openThread(thread);
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

  // Thread traversal and jump: the rail owns the order, so Mod+Shift+[ / ] and Mod+1..9 walk the
  // same rows the user sees.
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
    const key = threadKeyOf(thread);
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
    selection.selectedThreadKeys.has(threadKeyOf(thread)),
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

  const wakeShelfThread = (thread: EnvironmentThreadShell, open = true) => {
    void (async () => {
      const result = await actions.unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to bring thread back", result) && open) openThread(thread);
    })();
  };

  const reopenShelfThread = (thread: EnvironmentThreadShell, open = true) => {
    void (async () => {
      const result = await actions.unsettleThread(scopeThreadRef(thread.environmentId, thread.id));
      if (!reportFailure("Failed to reopen thread", result) && open) openThread(thread);
    })();
  };

  // A shelf row dropped into the rail returns to its workspace without moving the user.
  const returnShelfThreadFromDrag = (source: ThreadDragSource) => {
    const thread = threadById.get(source.threadId);
    if (thread === undefined) return false;
    const action = shelfReturnAction(thread, nowIso);
    if (action === "wake") wakeShelfThread(thread, false);
    else if (action === "reopen") reopenShelfThread(thread, false);
    return action !== null;
  };

  // The server moves the thread, its children and their tabs in one step but does not move the
  // user; the toast offers the workspace and the way back.
  const moveThreadToWorkspace = (
    thread: { environmentId: string; id: string; title: string | null },
    target: string | "new-workspace",
  ) => {
    const current = memberships.byThread.get(threadKeyOf(thread))?.workspaceId;
    if (target === current) return;
    void moveThreadToWorkspaceWithFeedback({
      thread: { environmentId: thread.environmentId, threadId: thread.id },
      threadTitle: thread.title,
      target:
        target === "new-workspace"
          ? "new-workspace"
          : { workspaceId: target, name: workspaceNames.get(target) ?? "" },
      nameOf: (workspaceId) => workspaceNames.get(workspaceId) ?? "",
      onOpenTarget: (workspaceId) => useLayoutStore.getState().focusWorkspace(workspaceId),
    });
  };
  // A drop calls the move the thread menu calls; a tab without a server thread moves as a tab.
  const dropOnWorkspace = (source: DraggedThread, targetWorkspaceId: string) => {
    if (!isTabDragSource(source) && returnShelfThreadFromDrag(source)) return;
    const operation = resolveWorkspaceDrop(source, targetWorkspaceId);
    if (operation.kind === "move-thread") {
      const shell = threadById.get(operation.thread.threadId);
      moveThreadToWorkspace(
        shell ?? {
          environmentId: operation.thread.environmentId,
          id: operation.thread.threadId,
          title: operation.title,
        },
        operation.target,
      );
    } else if (operation.kind === "move-tab") {
      try {
        moveTabToWorkspaceDrop(operation.tabId, operation.target);
      } catch (error) {
        explain("Cannot move this tab", error instanceof Error ? error.message : String(error));
      }
    }
  };
  const workspaceMoveFor = (
    thread: EnvironmentThreadShell,
  ): ThreadActionMenuWorkspaceInput | undefined => {
    const entry = memberships.byThread.get(threadKeyOf(thread));
    // A subagent child follows its parent and has no workspace choice of its own.
    if (entry?.parentThreadId != null || thread.lineage.relationshipToParent === "subagent") {
      return undefined;
    }
    const current = entry?.workspaceId ?? null;
    return {
      targets: everything.sections
        .filter((section) => section.workspaceId !== current)
        .map((section) => ({ workspaceId: section.workspaceId, name: section.name })),
      onMove: (workspaceId) => moveThreadToWorkspace(thread, workspaceId),
      onMoveToNew: () => moveThreadToWorkspace(thread, "new-workspace"),
    };
  };

  const shelves = partitionShelfThreads(threads, projectKeys, nowIso);
  const runningSubagentsByThread = runningSubagentsByParentThread(threads, nowIso);

  const searchMatchThreads = sections.flatMap((section) => section.threads);

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
  const matchesQuery = (thread: EnvironmentThreadShell) =>
    thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
    (thread.branch?.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ?? false) ||
    thread.pullRequests.some((pullRequest) => `#${pullRequest.number}`.includes(query));
  const heldShown = searching ? shelves.held.filter(matchesQuery) : shelves.held;
  const closedShown = searching ? shelves.closed.filter(matchesQuery) : shelves.closed;
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
          projectKeys.has(projectKeyOf(match.environmentId, match.projectId)),
      })
    : [];
  // Opens a thread wherever it lives: in a workspace, on hold or closed.
  const openFoundThread = (thread: EnvironmentThreadShell) => {
    if (thread.settledOverride === "settled") reopenShelfThread(thread);
    else if (effectiveSnoozed(thread, { now: nowIso })) wakeShelfThread(thread);
    else openThread(thread);
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

  const openNeedsYouThread = (thread: EnvironmentThreadShell) => openThread(thread);

  const reorder = useWorkspaceReorderDrag((draggedId, targetId, side) =>
    reorderLayoutWorkspaceAction(draggedId, targetId, side),
  );

  const startCreatingWorkspace = () => setCreatingWorkspace(true);
  const createWorkspace = (name: string): string | null => {
    const refusal = createLayoutWorkspaceAction(name);
    if (refusal !== null) return refusal;
    // The new workspace is stored once it holds a tab, so it opens a launcher to start a thread in.
    openLayoutLauncherInWorkspaceAction(useLayoutStore.getState().layout.focusedWorkspaceId);
    return null;
  };

  const renderGroup = (section: SidebarWorkspaceSection, index: number) => (
    <SidebarWorkspaceGroup
      key={section.workspaceId}
      section={section}
      query={query}
      open={layout.focusedWorkspaceId === section.workspaceId}
      // A search opens every group so its matches show.
      collapsed={!searching && collapsedWorkspaces.collapsed.has(section.workspaceId)}
      onToggleCollapsed={() => collapsedWorkspaces.toggle(section.workspaceId)}
      previousWorkspaceId={sections[index - 1]?.workspaceId ?? null}
      nextWorkspaceId={sections[index + 1]?.workspaceId ?? null}
      hiddenWorkspaces={hiddenSections}
      focusedThreadKey={focusedThreadKey}
      providerEntriesByEnvironment={providerEntriesByEnvironment}
      projectTitleOf={projectTitleOf}
      nowIso={nowIso}
      selection={selection}
      runningSubagents={runningSubagentsByThread}
      dragging={dragging}
      reorder={{ drag: reorder.drag, begin: reorder.begin }}
      onOpenThread={openThread}
      onSelectThread={selectThread}
      onCloseThread={(thread) => closeThreads([thread])}
      onHoldThread={(thread, preset) => holdThreads([thread], preset.snoozedUntil)}
      onPickHoldTime={pickHoldTime}
      onDropOnWorkspace={dropOnWorkspace}
      onCreateWorkspace={startCreatingWorkspace}
      onRenameThread={renameThread}
      onSetAutoClose={setAutoClose}
      workspaceMoveFor={workspaceMoveFor}
      handleNewThread={handleNewThread}
      onDeleteWorkspace={(target) => void deleteWorkspaceAndThreads(target)}
    />
  );

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
              {isPage ? null : <SidebarChromeHeader isDesktopHost={isDesktopHost} />}
              {isPage ? null : (
                <SidebarHeader>
                  <SidebarRailNav
                    actions={
                      <SidebarToolbarActions
                        options={sidebarOptions}
                        onChange={(patch) => void updateClientSettings(sidebarOptionsPatch(patch))}
                        onReset={() =>
                          void updateClientSettings({
                            ...SIDEBAR_OPTIONS_DEFAULTS,
                            sidebarShowNeedsYou: isPhone,
                          })
                        }
                        onNewWorkspace={startCreatingWorkspace}
                      />
                    }
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
                            if (
                              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                              searching
                            ) {
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
                              const needle = query.toLocaleLowerCase();
                              const matchedWorkspace = sections.find((section) =>
                                section.name.toLocaleLowerCase().includes(needle),
                              );
                              if (matchedWorkspace !== undefined) {
                                const first = matchedWorkspace.threads[0];
                                if (first !== undefined) openThread(first);
                                else
                                  useLayoutStore
                                    .getState()
                                    .focusWorkspace(matchedWorkspace.workspaceId);
                                return;
                              }
                              const matchedProject = projects.find((project) =>
                                project.title.toLocaleLowerCase().includes(needle),
                              );
                              const projectTarget =
                                matchedProject === undefined
                                  ? undefined
                                  : railTargets.find(
                                      (target) =>
                                        target.environmentId === matchedProject.environmentId &&
                                        target.projectId === matchedProject.id,
                                    );
                              if (projectTarget !== undefined) openRailTarget(projectTarget);
                            }
                          }}
                          placeholder="Search"
                          aria-label="Search workspaces and threads"
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
                        ) : null}
                      </label>
                    }
                  />
                </SidebarHeader>
              )}
              <SidebarContent className="min-h-full">
                <div
                  ref={(element) => {
                    railRef.current = element;
                    return attachSidebarTree(element);
                  }}
                  className="flex flex-1 flex-col px-2 pb-10"
                >
                  <SidebarNeedsYouSection
                    entries={needsYouEntries}
                    providerEntriesByEnvironment={providerEntriesByEnvironment}
                    nowIso={nowIso}
                    selection={selection}
                    runningSubagents={runningSubagentsByThread}
                    dragging={dragging}
                    projectTitleOf={projectTitleOf}
                    workspaceMoveFor={workspaceMoveFor}
                    onOpenThread={openNeedsYouThread}
                    onSelectThread={selectThread}
                    onCloseThread={(thread) => closeThreads([thread])}
                    onHoldThread={(thread, preset) => holdThreads([thread], preset.snoozedUntil)}
                    onPickHoldTime={pickHoldTime}
                    onRenameThread={renameThread}
                    onSetAutoClose={setAutoClose}
                    handleNewThread={handleNewThread}
                  />
                  <SidebarWorkspacesHeader
                    hiddenWorkspaces={hiddenSections}
                    {...(isPage
                      ? {
                          phoneControls: {
                            options: sidebarOptions,
                            onChange: (patch: Partial<SidebarMenuOptions>) =>
                              void updateClientSettings(sidebarOptionsPatch(patch)),
                            onReset: () =>
                              void updateClientSettings({
                                ...SIDEBAR_OPTIONS_DEFAULTS,
                                sidebarShowNeedsYou: isPhone,
                              }),
                            onNewWorkspace: startCreatingWorkspace,
                          },
                        }
                      : {})}
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
                    {creatingWorkspace ? (
                      <NewWorkspaceField
                        onCreate={createWorkspace}
                        onDone={() => setCreatingWorkspace(false)}
                      />
                    ) : null}
                    {projects.length === 0 && query.length === 0 ? <SidebarNoProjects /> : null}
                    {sections.map(renderGroup)}
                    {searching ? <SidebarContentResults results={contentResults} /> : null}
                    {searching &&
                    sections.length === 0 &&
                    titleResultThreads.length === 0 &&
                    contentResults.length === 0 &&
                    !messageSearch.isPending ? (
                      <SidebarNoSearchResults query={query} />
                    ) : null}
                  </div>
                  {isPage ? null : (
                    <SidebarNewWorkspaceDropZone
                      onDrop={(source) => dropOnWorkspace(source, NEW_WORKSPACE_DROP)}
                    />
                  )}
                </div>
              </SidebarContent>
              {/* Collapses while SidebarShelves renders nothing (both shelves empty, no drag). */}
              <div
                ref={attachSidebarTree}
                className="shrink-0 px-2 pt-1 pb-1 empty:hidden"
                data-testid="sidebar-shelves-pin"
              >
                <SidebarShelves
                  held={heldShown}
                  closed={closedShown}
                  forceExpanded={searching}
                  older={{
                    scopes: olderSettledScopesForProjects(projects),
                    threads: threads.filter((thread) =>
                      projectKeys.has(projectKeyOf(thread.environmentId, thread.projectId)),
                    ),
                  }}
                  closedDropTarget={closedShelfIsDropTarget}
                  closedDragActive={dragging !== null}
                  onClosedDrop={(source) => {
                    const thread = threadById.get(source.threadId);
                    if (thread !== undefined) closeThreads([thread]);
                  }}
                  renderCard={(thread, shelf) => (
                    <ThreadCard
                      key={thread.id}
                      workspaceId={null}
                      thread={thread}
                      query={query}
                      providerEntries={
                        providerEntriesByEnvironment.get(thread.environmentId) ??
                        EMPTY_PROVIDER_ENTRIES
                      }
                      nowIso={nowIso}
                      focused={false}
                      selected={selection.selectedThreadKeys.has(threadKeyOf(thread))}
                      dragging={false}
                      runningSubagents={
                        runningSubagentsByThread.get(subagentParentKey(thread)) ?? 0
                      }
                      projectTitle={projectTitleOf(thread)}
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
                        render={<button type="button" className={SIDEBAR_EMPTY_ACTION_CLS} />}
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
                      className={SIDEBAR_EMPTY_ACTION_CLS}
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
              {isPage ? null : <SidebarChromeFooter />}
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

const SIDEBAR_OPTIONS_DEFAULTS = {
  sidebarGridThreadSortOrder: DEFAULT_SIDEBAR_GRID_THREAD_SORT_ORDER,
  sidebarRowShowBranch: true,
  sidebarRowShowPullRequest: true,
  sidebarRowShowSubagents: true,
} as const;

export function sidebarOptionsPatch(patch: Partial<SidebarMenuOptions>) {
  return {
    ...(patch.threadSort === undefined ? {} : { sidebarGridThreadSortOrder: patch.threadSort }),
    ...(patch.showBranch === undefined ? {} : { sidebarRowShowBranch: patch.showBranch }),
    ...(patch.showPullRequest === undefined
      ? {}
      : { sidebarRowShowPullRequest: patch.showPullRequest }),
    ...(patch.showSubagents === undefined ? {} : { sidebarRowShowSubagents: patch.showSubagents }),
    ...(patch.showNeedsYou === undefined ? {} : { sidebarShowNeedsYou: patch.showNeedsYou }),
  };
}

function HiddenWorkspacesMenu({
  workspaces,
  onShow,
}: {
  workspaces: ReadonlyArray<SidebarWorkspaceSection>;
  onShow: (workspaceId: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Hidden workspaces"
            className={SIDEBAR_SECTION_ACTION_CLS}
          />
        }
      >
        <EyeOffIcon aria-hidden className="size-[15px]" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        {workspaces.map((workspace) => (
          <MenuItem key={workspace.workspaceId} onClick={() => onShow(workspace.workspaceId)}>
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            <span className="text-2xs text-secondary-label">Show</span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The Workspaces label; its project filter and hidden-workspaces menu show on hover. The phone
 * page has no toolbar, so it passes `phoneControls` to keep view options, New workspace and Add
 * project in this header.
 */
export function SidebarWorkspacesHeader({
  hiddenWorkspaces = [],
  projectFilter = null,
  phoneControls,
}: {
  hiddenWorkspaces?: ReadonlyArray<SidebarWorkspaceSection>;
  /** The project filter picker, when there is more than one project to choose from. */
  projectFilter?: ReactNode;
  phoneControls?: {
    options: SidebarMenuOptions;
    onChange: (patch: Partial<SidebarMenuOptions>) => void;
    onReset: () => void;
    onNewWorkspace: () => void;
  };
}) {
  return (
    <SidebarSectionHeaderRow
      title="Workspaces"
      actions={
        <>
          {projectFilter}
          {hiddenWorkspaces.length > 0 ? (
            <HiddenWorkspacesMenu
              workspaces={hiddenWorkspaces}
              onShow={(workspaceId) => hideLayoutWorkspaceAction(workspaceId, false)}
            />
          ) : null}
          {phoneControls ? (
            <>
              <SidebarOptionsMenu
                options={phoneControls.options}
                onChange={phoneControls.onChange}
                onReset={phoneControls.onReset}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="New workspace"
                      onClick={phoneControls.onNewWorkspace}
                      className={SIDEBAR_SECTION_ACTION_CLS}
                    />
                  }
                >
                  <PlusIcon aria-hidden className="size-[15px]" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">New workspace</TooltipPopup>
              </Tooltip>
              <SidebarAddProjectButton sectionAction />
            </>
          ) : null}
        </>
      }
    />
  );
}

/**
 * The quiet icon buttons beside the search field: new thread, add project and view options. New
 * workspace sits at the top of the view options menu.
 */
export function SidebarToolbarActions({
  options,
  onChange,
  onReset,
  onNewWorkspace,
}: {
  options: SidebarMenuOptions;
  onChange: (patch: Partial<SidebarMenuOptions>) => void;
  onReset: () => void;
  onNewWorkspace: () => void;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New thread"
              onClick={() => openCommandPalette({ open: "new-thread-in", newTab: true })}
              className={SIDEBAR_TOOLBAR_ACTION_CLS}
            />
          }
        >
          <SquarePenIcon aria-hidden className="size-[15px]" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New thread</TooltipPopup>
      </Tooltip>
      <SidebarAddProjectButton />
      <SidebarOptionsMenu
        options={options}
        onChange={onChange}
        onReset={onReset}
        onNewWorkspace={onNewWorkspace}
        toolbar
      />
    </>
  );
}

/** Add project: opens the chooser for a folder, a clone or a new repository. */
export function SidebarAddProjectButton({ sectionAction = false }: { sectionAction?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Add project"
            onClick={() => openAddProjectDialog()}
            className={sectionAction ? SIDEBAR_SECTION_ACTION_CLS : SIDEBAR_TOOLBAR_ACTION_CLS}
          />
        }
      >
        <FolderPlusIcon aria-hidden className="size-[15px]" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Add project</TooltipPopup>
    </Tooltip>
  );
}

/** A name field for a new workspace; Enter creates it, Escape or an empty blur cancels. */
function NewWorkspaceField({
  onCreate,
  onDone,
}: {
  onCreate: (name: string) => string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      onDone();
      return;
    }
    const result = onCreate(trimmed);
    if (result === null) {
      onDone();
      return;
    }
    setRefusal(result);
  };
  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      <input
        autoFocus
        value={name}
        placeholder="Workspace name"
        aria-label="New workspace name"
        aria-invalid={refusal !== null}
        onChange={(event) => {
          setName(event.target.value);
          setRefusal(null);
        }}
        onBlur={() => {
          if (refusal === null) submit();
          else onDone();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") {
            event.stopPropagation();
            onDone();
          }
        }}
        className={SIDEBAR_GROUP_RENAME_CLS}
      />
      {refusal === null ? null : (
        <span role="alert" className="px-1 text-2xs text-destructive-foreground">
          {refusal}
        </span>
      )}
    </div>
  );
}

function workspaceRowId(workspaceId: string) {
  return `workspace:${workspaceId}`;
}

/** The threads that wait on the user, lifted above the workspaces when the rail shows them. */
export function SidebarNeedsYouSection({
  entries,
  providerEntriesByEnvironment,
  nowIso,
  selection,
  runningSubagents,
  dragging,
  projectTitleOf,
  workspaceMoveFor,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onRenameThread,
  onSetAutoClose,
  handleNewThread,
}: {
  entries: ReadonlyArray<NeedsYouEntry>;
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>;
  nowIso: string;
  selection: ThreadSelection;
  runningSubagents: ReadonlyMap<string, number>;
  dragging: ThreadDragSource | null;
  projectTitleOf: (thread: EnvironmentThreadShell) => string;
  workspaceMoveFor?: (thread: EnvironmentThreadShell) => ThreadActionMenuWorkspaceInput | undefined;
  onOpenThread: (thread: EnvironmentThreadShell) => void;
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
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  handleNewThread?: NewThreadHandler | undefined;
}) {
  // Nothing needs the user: the section is not a permanent empty shelf on the rail.
  if (entries.length === 0) return null;
  return (
    <section
      aria-label="Needs you"
      data-needs-you-section=""
      className={SIDEBAR_NEEDS_YOU_SECTION_CLS}
    >
      <div data-needs-you-heading="" className={SIDEBAR_NEEDS_YOU_HEADING_CLS}>
        <span aria-hidden className={SIDEBAR_NEEDS_YOU_HEADING_GLYPH_CLS} />
        <span className="min-w-0 truncate">Needs you</span>
        <span data-heading-count="" className={SIDEBAR_GROUP_COUNT_CLS}>
          {entries.length}
        </span>
      </div>
      <div className={SIDEBAR_NEEDS_YOU_SECTION_CLS}>
        {entries.map(({ thread }) => (
          <ThreadCard
            key={thread.id}
            workspaceId={null}
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
            dragging={dragging?.threadId === thread.id}
            runningSubagents={runningSubagents.get(subagentParentKey(thread)) ?? 0}
            projectTitle={projectTitleOf(thread)}
            onOpen={() => onOpenThread(thread)}
            onSelect={(input) => onSelectThread(thread, input)}
            onClose={() => onCloseThread(thread)}
            onHold={(preset) => onHoldThread(thread, preset)}
            onPickHoldTime={onPickHoldTime}
            onRename={(title) => onRenameThread(thread, title)}
            onSetAutoClose={(enabled) => onSetAutoClose(thread, enabled)}
            onDropOnThread={() => {}}
            workspaceMove={workspaceMoveFor?.(thread)}
            handleNewThread={handleNewThread}
          />
        ))}
      </div>
    </section>
  );
}

/** One layout workspace: its heading, then the threads whose chat tab it holds. */
export function SidebarWorkspaceGroup({
  section,
  query,
  open,
  collapsed,
  onToggleCollapsed,
  previousWorkspaceId,
  nextWorkspaceId,
  hiddenWorkspaces,
  focusedThreadKey,
  providerEntriesByEnvironment,
  projectTitleOf,
  nowIso,
  selection,
  runningSubagents,
  dragging,
  reorder,
  onOpenThread,
  onSelectThread,
  onCloseThread,
  onHoldThread,
  onPickHoldTime,
  onDropOnWorkspace,
  onCreateWorkspace,
  onRenameThread,
  onSetAutoClose,
  workspaceMoveFor,
  handleNewThread,
  onDeleteWorkspace,
}: {
  section: SidebarWorkspaceSection;
  query: string;
  /** Whether the layout's focus is in this workspace. */
  open: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  previousWorkspaceId: string | null;
  nextWorkspaceId: string | null;
  hiddenWorkspaces: ReadonlyArray<SidebarWorkspaceSection>;
  focusedThreadKey: string | null;
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>;
  projectTitleOf: (thread: EnvironmentThreadShell) => string;
  nowIso: string;
  selection: ThreadSelection;
  runningSubagents: ReadonlyMap<string, number>;
  dragging: ThreadDragSource | null;
  reorder: {
    drag: WorkspaceReorderDrag | null;
    begin: (event: React.PointerEvent<HTMLElement>, workspaceKey: string) => void;
  };
  onOpenThread: (thread: EnvironmentThreadShell) => void;
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
  onDropOnWorkspace: (source: DraggedThread, targetWorkspaceId: string) => void;
  onCreateWorkspace: () => void;
  onRenameThread: (thread: EnvironmentThreadShell, title: string) => void;
  onSetAutoClose: (thread: EnvironmentThreadShell, enabled: boolean) => void;
  workspaceMoveFor: (thread: EnvironmentThreadShell) => ThreadActionMenuWorkspaceInput | undefined;
  handleNewThread?: NewThreadHandler | undefined;
  /** Deletes the workspace and its threads after asking; absent, the menu item does nothing. */
  onDeleteWorkspace?: ((section: SidebarWorkspaceSection) => void) | undefined;
}) {
  const { workspaceId, name: workspaceName, threads } = section;
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workspaceName);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const newThreadShortcut = shortcutLabelForCommand(keybindings, "chat.new");
  const dropTarget = useThreadDropTarget();
  const isDropTarget = dropTarget?.kind === "workspace" && dropTarget.workspaceId === workspaceId;
  const headingHovered = isDropTarget && dropTarget.heading === true;
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  // A workspace takes a drop from anywhere in its section, collapsed or not, unless the dragged
  // thing already sits in it: that drop would change nothing, so it is no target at all.
  useThreadDropZone(
    sectionRef,
    (_point, source) =>
      dragSourceWorkspaceId(source) === workspaceId ? null : { kind: "workspace", workspaceId },
    (source) => onDropOnWorkspace(source, workspaceId),
  );
  useThreadDropZone(
    headerRef,
    (_point, source) =>
      dragSourceWorkspaceId(source) === workspaceId
        ? null
        : { kind: "workspace", workspaceId, heading: true },
    (source) => onDropOnWorkspace(source, workspaceId),
  );
  // Resting on a heading shows that workspace, so the drop can name one of its panes.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- a timer that lasts as long as the hover
  useEffect(() => {
    if (!headingHovered || open) return;
    const timer = window.setTimeout(
      () => useLayoutStore.getState().focusWorkspace(workspaceId),
      WORKSPACE_SPRING_LOAD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [headingHovered, open, workspaceId]);
  const reorderHighlight =
    !renaming && reorder.drag !== null && reorder.drag.targetKey === workspaceId;
  const reorderTarget =
    reorder.drag !== null && reorder.drag.targetKey === workspaceId ? reorder.drag.side : null;
  const revealedThread = collapsed
    ? threads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === focusedThreadKey,
      )
    : undefined;
  const shownThreads = revealedThread === undefined ? (collapsed ? [] : threads) : [revealedThread];
  const readyThreads = threads.filter(
    (thread) => resolveThreadRowState(thread, nowIso) === "ready",
  );
  const startRenaming = () => {
    setDraftName(workspaceName);
    setRenaming(true);
  };
  const finishRenaming = () => {
    setRenaming(false);
    if (draftName.trim() === workspaceName) return;
    const refusal = renameLayoutWorkspaceAction(workspaceId, draftName);
    if (refusal !== null) explain("Could not rename workspace", refusal);
  };
  const createThread = () => openLayoutLauncherInWorkspaceAction(workspaceId);
  const deleteWorkspace = () => {
    // The last workspace cannot go; say so at once instead of asking to confirm a refused delete.
    const remaining = useLayoutStore.getState().layout.workspaces.length;
    if (previousWorkspaceId === null && nextWorkspaceId === null && hiddenWorkspaces.length === 0) {
      explain(
        "Could not delete workspace",
        `“${workspaceName}” is the last workspace (${remaining} in the layout); a layout keeps at least one.`,
      );
      return;
    }
    onDeleteWorkspace?.(section);
  };

  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const openWorkspaceMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items = workspaceHeadingMenuItems({
      pinned: section.pinned,
      canMoveUp: previousWorkspaceId !== null,
      canMoveDown: nextWorkspaceId !== null,
      readyCount: readyThreads.length,
      hiddenWorkspaces: hiddenWorkspaces.map((hidden) => ({
        id: hidden.workspaceId,
        name: hidden.name,
      })),
    });
    setMenuOpen(true);
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    setMenuOpen(false);
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const action = clicked.value;
    const hiddenId = hiddenWorkspaceIdFromAction(action);
    if (hiddenId !== null) {
      hideLayoutWorkspaceAction(hiddenId, false);
      return;
    }
    switch (action) {
      case "new-thread":
        createThread();
        return;
      case "rename":
        startRenaming();
        return;
      case "toggle-pin":
        pinLayoutWorkspaceAction(workspaceId, !section.pinned);
        return;
      case "move-up":
        if (previousWorkspaceId !== null)
          reorderLayoutWorkspaceAction(workspaceId, previousWorkspaceId, "before");
        return;
      case "move-down":
        if (nextWorkspaceId !== null)
          reorderLayoutWorkspaceAction(workspaceId, nextWorkspaceId, "after");
        return;
      case "hide":
        hideLayoutWorkspaceAction(workspaceId, true);
        return;
      case "delete":
        deleteWorkspace();
        return;
      case "close-ready":
        for (const thread of readyThreads) onCloseThread(thread);
        return;
      case "new-workspace":
        onCreateWorkspace();
        return;
    }
  };
  const openWorkspaceMenuBelow = (element: HTMLElement | null) => {
    const rect = element?.getBoundingClientRect();
    if (rect === undefined) return;
    void openWorkspaceMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <div
      ref={sectionRef}
      className={cn("mt-0.5 flex flex-col", isDropTarget && SIDEBAR_GROUP_SECTION_DROP_CLS)}
      data-workspace-key={workspaceId}
      data-drop-over={isDropTarget || undefined}
      {...{ [WORKSPACE_REORDER_ATTRIBUTE]: "" }}
    >
      <div
        ref={headerRef}
        data-workspace-heading-row=""
        data-workspace-heading=""
        data-reorder-side={reorderTarget ?? undefined}
        className={cn(
          SIDEBAR_GROUP_HEADING_ROW_CLS,
          reorderHighlight && SIDEBAR_GROUP_HEADING_DROP_CLS,
        )}
        onPointerDown={(event) => {
          if (renaming) return;
          reorder.begin(event, workspaceId);
        }}
        onContextMenu={(event) => {
          if (renaming) return;
          event.preventDefault();
          void openWorkspaceMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {renaming ? (
          <input
            autoFocus
            value={draftName}
            aria-label={`Rename workspace ${workspaceName}`}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={finishRenaming}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftName(workspaceName);
                setRenaming(false);
              }
            }}
            className={SIDEBAR_GROUP_RENAME_CLS}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-sidebar-row={workspaceRowId(workspaceId)}
                  onClick={onToggleCollapsed}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      startRenaming();
                      return;
                    }
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      event.preventDefault();
                      openWorkspaceMenuBelow(event.currentTarget);
                    }
                  }}
                  aria-expanded={!collapsed}
                  className={SIDEBAR_GROUP_HEADING_CLS}
                >
                  <span className={SIDEBAR_GROUP_CHEVRON_BOX_CLS} data-workspace-chevron-box="">
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        SIDEBAR_GROUP_CHEVRON_CLS,
                        !collapsed && SIDEBAR_GROUP_CHEVRON_EXPANDED_CLS,
                      )}
                    />
                  </span>
                  <span data-workspace-name="" className={sidebarGroupNameCls(open)}>
                    <HighlightedText text={workspaceName} query={query} />
                  </span>
                  {section.pinned ? (
                    <PinIcon
                      aria-label="Pinned"
                      data-workspace-pin=""
                      className="size-3 shrink-0 text-secondary-label"
                    />
                  ) : null}
                  {threads.length === 0 ? (
                    <span className={SIDEBAR_ROW_TRAILING_CLS} data-heading-trailing="">
                      <span className={SIDEBAR_GROUP_EMPTY_CLS}>empty</span>
                    </span>
                  ) : collapsed ? (
                    <span className={SIDEBAR_ROW_TRAILING_CLS} data-heading-trailing="">
                      {threads.some((thread) => isNeedsYouThread(thread, nowIso)) ? (
                        <span
                          aria-hidden
                          className={SIDEBAR_NEEDS_YOU_DOT_CLS}
                          data-needs-you-dot=""
                        />
                      ) : null}
                      <span className={SIDEBAR_GROUP_COUNT_CLS} data-heading-count="">
                        {threads.length}
                      </span>
                    </span>
                  ) : null}
                </button>
              }
            />
            <TooltipPopup side="bottom" align="start">
              {workspaceName}
            </TooltipPopup>
          </Tooltip>
        )}
        {renaming ? null : (
          <span className={SIDEBAR_ROW_ACTIONS_CLS}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${workspaceName}`}
                    onClick={createThread}
                    className={SIDEBAR_GROUP_ACTION_CLS}
                  />
                }
              >
                <PlusIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {newThreadShortcut === null
                  ? `New thread in ${workspaceName}`
                  : `New thread in ${workspaceName} · ${newThreadShortcut}`}
              </TooltipPopup>
            </Tooltip>
            <button
              ref={actionsButtonRef}
              type="button"
              aria-label={`Workspace actions for ${workspaceName}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => openWorkspaceMenuBelow(actionsButtonRef.current)}
              className={cn(SIDEBAR_GROUP_ACTION_CLS, menuOpen && "opacity-100")}
            >
              <MoreHorizontalIcon aria-hidden className="size-3.5" />
            </button>
          </span>
        )}
      </div>
      <AnimatedHeight>
        {threads.length === 0 && !collapsed ? (
          <div data-workspace-empty="" className={cn(SIDEBAR_GROUP_THREADS_CLS, "py-1")}>
            <div className="flex items-center gap-2 px-2 text-xs text-secondary-label">
              <span className="min-w-0 flex-1 truncate">No threads yet</span>
              <button type="button" onClick={createThread} className={SIDEBAR_EMPTY_ACTION_CLS}>
                New thread
              </button>
            </div>
          </div>
        ) : shownThreads.length === 0 ? null : (
          <div data-workspace-guide="" className={SIDEBAR_GROUP_THREADS_CLS}>
            {shownThreads.map((thread) => {
              const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              return (
                <ThreadCard
                  key={thread.id}
                  workspaceId={workspaceId}
                  thread={thread}
                  query={query}
                  providerEntries={
                    providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
                  }
                  nowIso={nowIso}
                  focused={open && focusedThreadKey === key}
                  selected={selection.selectedThreadKeys.has(key)}
                  dragging={dragging?.threadId === thread.id}
                  runningSubagents={runningSubagents.get(subagentParentKey(thread)) ?? 0}
                  projectTitle={projectTitleOf(thread)}
                  treeParent={workspaceRowId(workspaceId)}
                  onOpen={() => onOpenThread(thread)}
                  onSelect={(input) => onSelectThread(thread, input)}
                  onClose={() => onCloseThread(thread)}
                  onHold={(preset) => onHoldThread(thread, preset)}
                  onPickHoldTime={onPickHoldTime}
                  onRename={(title) => onRenameThread(thread, title)}
                  onSetAutoClose={(enabled) => onSetAutoClose(thread, enabled)}
                  onDropOnThread={(source) => onDropOnWorkspace(source, workspaceId)}
                  workspaceMove={workspaceMoveFor(thread)}
                  handleNewThread={handleNewThread}
                />
              );
            })}
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
}
