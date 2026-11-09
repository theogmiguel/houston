import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import { GridEmptyDraft } from "../components/grid/GridEmptyDraft";
import { ThreadOpenProvider } from "../components/grid/threadOpenContext";
import { GridHost } from "../components/grid/GridHost";
import { GridRightPanelPin } from "../components/chat/GridRightPanelPin";
import { GridThreadBranch } from "../components/grid/GridThreadBranch";
import { GridThreadCell } from "../components/grid/GridThreadCell";
import { GridTerminalDock } from "../components/grid/GridTerminalDock";
import { clearInlineDetailsHandoff } from "../components/chat/inlineDetailsFollow";
import { GridTopBarControls } from "../components/grid/GridTopBarControls";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isDesktopHost } from "../env";
import { isNativeDesktopHost } from "../lib/desktopWindow";
import { gridTerminalThreadRef } from "../grid/gridTerminal";
import { MAX_GRID_THREADS, useGrid, useGridStore, workspaceKeyOf } from "../grid/gridStore";
import { showThreadMovedToast } from "../grid/moveFeedback";
import {
  crossProjectMoveToast,
  gridFullMoveToast,
  noProjectMoveToast,
  sameProject,
} from "../grid/projectMove";
import { useOpenGridDraft } from "../grid/useOpenGridDraft";
import { useGridShortcuts } from "../grid/useGridShortcuts";
import { rememberLastOpenGridId } from "../grid/lastGrid";
import { useGridMaximizeStore } from "../grid/gridMaximizeStore";
import { ungroupedWorkspaceThreads } from "../grid/rail";
import { resolveGridThreadOpen, type ThreadOpenIntent } from "../grid/gridThreadOpen";
import { containsThread, preorderThreads } from "../grid/tree";
import { cn } from "../lib/utils";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useIsPhone } from "../mobile/usePhone";
import { useNowMinute } from "../hooks/useNowMinute";
import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadActions } from "../hooks/useThreadActions";
import { closeGridThread } from "../grid/closeGridThread";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { resolveShortcutCommand } from "../keybindings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShells, useProjects } from "../state/entities";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { isSidebarHiddenThread } from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";

export const Route = createFileRoute("/_chat/grid/$gridId")({
  component: GridRoute,
});

function GridRoute() {
  const { gridId } = Route.useParams();
  const grid = useGrid(gridId);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const allGrids = useGridStore((store) => store.grids);
  const navigate = useNavigate();
  const setTree = useGridStore((store) => store.setTree);
  const addThread = useGridStore((store) => store.addThread);
  const focusThread = useGridStore((store) => store.focusThread);
  const setGridDetailsOpen = useGridStore((store) => store.setGridDetailsOpen);
  const threadActions = useThreadActions();
  const reorderGridThreads = useGridStore((store) => store.reorderGridThreads);
  const moveThreadToCell = useGridStore((store) => store.moveThreadToCell);
  const openDraft = useOpenGridDraft();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const prefersSheetPanel = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isPhone = useIsPhone();
  const [gridRow, setGridRow] = useState<HTMLDivElement | null>(null);
  const [rightPanelHost, setRightPanelHost] = useState<HTMLDivElement | null>(null);
  const [emptyDraftThreadId, setEmptyDraftThreadId] = useState<string | null>(null);
  const threadDetailsAnchorRef = useRef<HTMLElement | null>(null);
  const maximizedThreadId = useGridMaximizeStore(
    (store) => store.maximizedThreadIdByGrid[gridId] ?? null,
  );
  const storeMaximizedThreadId = useGridMaximizeStore((store) => store.setMaximizedThreadId);
  const setMaximizedThreadId = (threadId: string | null) =>
    storeMaximizedThreadId(gridId, threadId);
  const focusedThreadId = grid?.focusedThreadId ?? null;
  const previousFocusedThreadIdRef = useRef<string | null>(focusedThreadId);
  // The panel follows the focused cell unless the grid pins it to one thread.
  const pinnedPanelThreadId = grid?.panelPinnedThreadId ?? null;
  const panelThreadId = pinnedPanelThreadId ?? focusedThreadId;
  const setPanelPinnedThread = useGridStore((store) => store.setPanelPinnedThread);
  const panelRef =
    grid === null || panelThreadId === null
      ? null
      : scopeThreadRef(grid.environmentId as EnvironmentId, panelThreadId as ThreadId);
  const panelThreadKey = panelRef === null ? null : scopedThreadKey(panelRef);
  const focusedRightPanel = useRightPanelStore((state) =>
    panelThreadKey === null ? null : (state.byThreadKey[panelThreadKey] ?? null),
  );
  const focusedRightPanelOpen = focusedRightPanel?.isOpen === true;
  const focusedRightPanelMaximized = focusedRightPanelOpen && focusedRightPanel?.maximized === true;
  const panelBesideGrid =
    focusedRightPanelOpen && (!prefersSheetPanel || focusedRightPanelMaximized);
  const gridDetailsOpen = grid?.detailsOpen === true;

  // A pin outlives only the panel it keeps: closing the panel, by any control, unpins it.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- unpins the grid when the pinned thread's panel closes
  useEffect(() => {
    if (pinnedPanelThreadId !== null && !focusedRightPanelOpen) {
      setPanelPinnedThread(gridId, null);
    }
  }, [focusedRightPanelOpen, gridId, pinnedPanelThreadId, setPanelPinnedThread]);

  const toggleThreadDetails = useStableCallback(() => {
    const current = useGridStore.getState().grids.find((entry) => entry.id === gridId);
    if (current === undefined) return;
    if (current.tree === null) {
      // An empty grid's draft has no tree leaf, so it keeps the per-thread flag.
      const threadId = emptyDraftThreadId ?? current.focusedThreadId;
      if (threadId === null) return;
      const ref = scopeThreadRef(current.environmentId as EnvironmentId, threadId as ThreadId);
      const store = useRightPanelStore.getState();
      const presentation =
        store.threadPanelPresentationByThreadKey[scopedThreadKey(ref)] ?? "inline";
      store.toggleThreadPanel(ref, presentation);
      return;
    }
    const open = current.detailsOpen !== true;
    if (!open) clearInlineDetailsHandoff();
    setGridDetailsOpen(gridId, open);
  });

  const closeGridDetails = (open: boolean) => {
    if (open) return;
    clearInlineDetailsHandoff();
    setGridDetailsOpen(gridId, false);
  };

  // A grid that leaves the screen must not hand a stale rect to the next one.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears the details follow handoff when the route unmounts
  useEffect(() => () => clearInlineDetailsHandoff(), []);

  // Launch restores the grid last on screen instead of a fresh standalone draft.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- persists the open grid id to local storage
  useEffect(() => {
    if (grid !== null) rememberLastOpenGridId(grid.id);
  }, [grid]);

  // The grid's cells are embedded chats, which leave window shortcuts to the route.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window keydown listener for the focused thread's right panel shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, { context: {} });
      if (
        command !== "rightPanel.toggle" &&
        command !== "rightPanel.toggleMaximized" &&
        command !== "threadPanel.toggle"
      )
        return;
      const current = useGridStore.getState().grids.find((entry) => entry.id === gridId);
      if (current === undefined) return;
      if (command === "threadPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        toggleThreadDetails();
        return;
      }
      const shortcutThreadId = current.panelPinnedThreadId ?? current.focusedThreadId;
      if (shortcutThreadId === null) return;
      const ref = scopeThreadRef(
        current.environmentId as EnvironmentId,
        shortcutThreadId as ThreadId,
      );
      const store = useRightPanelStore.getState();
      const threadPanel = store.byThreadKey[scopedThreadKey(ref)];
      if (command === "rightPanel.toggleMaximized" && threadPanel?.isOpen !== true) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (command === "rightPanel.toggle" && threadPanel?.isOpen === true) {
        store.setMaximized(ref, false);
        store.close(ref);
        useGridStore.getState().setPanelPinnedThread(gridId, null);
        return;
      }
      if (command === "rightPanel.toggle") {
        store.toggleVisibility(ref);
        return;
      }
      store.setMaximized(ref, threadPanel?.maximized !== true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [gridId, keybindings, toggleThreadDetails]);

  // A popover card belongs to one cell. Following focus would reopen it over the next
  // thread, so a focus move out of a popover cell turns the grid's details off.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- closes the compact popover when the focused cell changes
  useLayoutEffect(() => {
    const previousThreadId = previousFocusedThreadIdRef.current;
    previousFocusedThreadIdRef.current = focusedThreadId;
    if (grid === null || previousThreadId === null || previousThreadId === focusedThreadId) return;
    const store = useRightPanelStore.getState();
    const previousRef = scopeThreadRef(
      grid.environmentId as EnvironmentId,
      previousThreadId as ThreadId,
    );
    if (store.threadPanelPresentationByThreadKey[scopedThreadKey(previousRef)] !== "popover")
      return;
    if (useGridStore.getState().grids.find((entry) => entry.id === grid.id)?.detailsOpen !== true)
      return;
    clearInlineDetailsHandoff();
    setGridDetailsOpen(grid.id, false);
  }, [focusedThreadId, grid, setGridDetailsOpen]);

  const nowMinute = useNowMinute();
  const nowIso = `${nowMinute}:00.000Z`;
  const workspaceThreads =
    grid === null
      ? []
      : shells.filter(
          (thread) =>
            thread.environmentId === grid.environmentId &&
            thread.projectId === grid.projectId &&
            thread.archivedAt === null &&
            thread.deletedAt === null &&
            thread.settledOverride !== "settled" &&
            !effectiveSnoozed(thread, { now: nowIso }) &&
            !isSidebarHiddenThread(thread),
        );
  const threadCount = grid === null || grid.tree === null ? 0 : preorderThreads(grid.tree).length;
  const effectiveMaximized =
    maximizedThreadId !== null &&
    grid !== null &&
    grid.tree !== null &&
    containsThread(grid.tree, maximizedThreadId)
      ? maximizedThreadId
      : null;
  // A phone shows the focused thread alone; the rest of the grid stays in the tree.
  const phoneThreadId =
    isPhone && grid !== null && grid.tree !== null
      ? (grid.focusedThreadId ?? preorderThreads(grid.tree)[0]?.threadId ?? null)
      : null;
  const shownMaximizedThreadId = effectiveMaximized ?? phoneThreadId;
  const phoneThreadPage = isPhone && phoneThreadId !== null;

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- a grid change or a removed cell must not leave another cell maximized
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the setter is recreated each render; a grid change is the only trigger
    setMaximizedThreadId(null);
  }, [gridId]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears a maximize whose cell left the tree
  useEffect(() => {
    if (maximizedThreadId !== null && effectiveMaximized === null) setMaximizedThreadId(null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the setter is recreated each render; the maximize store drives this reset
  }, [effectiveMaximized, maximizedThreadId]);

  useGridShortcuts({
    gridId,
    keybindings,
    maximizedThreadId: effectiveMaximized,
    setMaximizedThreadId,
    isThreadAvailable: (threadId) => workspaceThreads.some((thread) => thread.id === threadId),
  });

  if (grid === null) {
    return (
      <SidebarInset className="min-h-0 items-center justify-center overflow-hidden">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium">This grid no longer exists</p>
          <p className="text-xs text-muted-foreground">
            It was deleted on this machine, or its workspace is no longer open.
          </p>
          <Link to="/" className="text-xs text-primary underline-offset-4 hover:underline">
            Back to threads
          </Link>
        </div>
      </SidebarInset>
    );
  }

  // A grid's terminal belongs to the grid while it shows its cells; a maximized
  // cell keeps the thread's own drawer.
  const gridTerminalRef =
    shownMaximizedThreadId === null
      ? gridTerminalThreadRef(grid.environmentId as EnvironmentId, grid.id)
      : null;
  const projectTitles = new Map(
    projects.map((project) => [workspaceKeyOf(project.environmentId, project.id), project.title]),
  );
  const projectTitleOf = (owner: { environmentId: string; projectId: string }) =>
    projectTitles.get(workspaceKeyOf(owner.environmentId, owner.projectId)) ?? owner.projectId;
  const visibleThreadIds = new Set(
    (grid.tree === null ? [] : preorderThreads(grid.tree)).map((leaf) => leaf.threadId),
  );
  // A split picker never offers a thread another grid already shows, nor a
  // closed, held, archived or subagent thread: one thread, one ChatView.
  const availableThreads = ungroupedWorkspaceThreads({
    project: {
      environmentId: grid.environmentId,
      id: grid.projectId,
      title: grid.name,
    },
    grids: allGrids,
    threads: shells,
    now: nowIso,
  }).map((thread) => ({ threadId: thread.id, title: thread.title }));
  const soloLeaves = grid.tree === null ? [] : preorderThreads(grid.tree);
  const gridCells = soloLeaves.map((leaf) => ({
    threadId: leaf.threadId,
    title:
      workspaceThreads.find((thread) => thread.id === leaf.threadId)?.title ?? "Untitled thread",
  }));
  const soloThread =
    soloLeaves.length === 1
      ? (workspaceThreads.find((thread) => thread.id === soloLeaves[0]!.threadId) ?? null)
      : null;
  const displayedSoloThread =
    shownMaximizedThreadId === null
      ? soloThread
      : (workspaceThreads.find((thread) => thread.id === shownMaximizedThreadId) ?? null);

  const openThread = (
    environmentId: string,
    threadId: string,
    fromThreadId: string | null,
    intent: ThreadOpenIntent = "peek",
  ) => {
    const placement = resolveGridThreadOpen({
      tree: grid.tree,
      gridEnvironmentId: grid.environmentId,
      environmentId,
      threadId,
      fromThreadId,
      inWorkspace: workspaceThreads.some((thread) => thread.id === threadId),
      intent,
      hasRoom: soloLeaves.length < MAX_GRID_THREADS,
    });
    if (placement.kind === "navigate") {
      if (intent === "join" && environmentId === grid.environmentId) {
        toastManager.add({
          type: "info",
          title: `“${grid.name}” is full`,
          description: `A grid holds at most ${MAX_GRID_THREADS} threads and it already shows ${soloLeaves.length}, so the thread opened on its own page.`,
        });
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId),
        ),
      });
      return;
    }
    if (placement.kind === "add") addThread(grid.id, threadId);
    if (placement.kind === "replace") {
      moveThreadToCell({
        threadId,
        targetGridId: grid.id,
        targetThreadId: placement.cellThreadId,
        side: "center",
      });
      // A maximized cell stays maximized with the thread that took its place.
      if (effectiveMaximized === placement.cellThreadId) setMaximizedThreadId(threadId);
    }
    focusThread(grid.id, threadId);
    void navigate({ to: "/grid/$gridId", params: { gridId: grid.id } });
  };

  const createThread = (side: "left" | "right" | "top" | "bottom", besideThreadId: string) => {
    void openDraft({
      gridId: grid.id,
      focusedThreadId: besideThreadId,
      side,
    });
  };

  return (
    <SidebarInset
      data-grid-new-thread-shortcut=""
      className="min-h-0 overflow-hidden overscroll-y-none"
    >
      <div ref={setGridRow} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          data-grid-page=""
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            phoneThreadPage && "pb-safe",
            focusedRightPanelMaximized && "hidden",
          )}
        >
          {phoneThreadPage ? null : (
            <WorkspacePageHeader
              desktop={isDesktopHost}
              reserveNativeControls={!panelBesideGrid && isNativeDesktopHost()}
              besidePanel={panelBesideGrid}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0" data-grid-crumb-project="">
                  {projectTitleOf(grid)}
                </span>
                <span aria-hidden>/</span>
                {/* The last crumb is the current place: the grid, or the one thread on screen. */}
                {[
                  { id: grid.id, label: grid.name },
                  ...(displayedSoloThread === null
                    ? []
                    : [{ id: displayedSoloThread.id, label: displayedSoloThread.title }]),
                ].map((crumb, index, crumbs) => (
                  <Fragment key={crumb.id}>
                    {index > 0 ? <span aria-hidden>/</span> : null}
                    <span
                      className={cn(
                        "truncate",
                        index === crumbs.length - 1 && "font-medium text-foreground",
                      )}
                    >
                      {crumb.label}
                    </span>
                  </Fragment>
                ))}
                {displayedSoloThread === null ? null : (
                  <>
                    {displayedSoloThread.branch ? (
                      <GridThreadBranch
                        branch={displayedSoloThread.branch}
                        worktreePath={displayedSoloThread.worktreePath}
                      />
                    ) : null}
                  </>
                )}
              </span>
              {effectiveMaximized === null ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setMaximizedThreadId(null)}
                >
                  <LayoutGridIcon />
                  Back to grid · {Math.max(0, threadCount - 1)}
                </Button>
              )}
              <span className="flex-1" />
              <GridTopBarControls
                grid={grid}
                gridTerminalRef={gridTerminalRef}
                emptyDraftThreadId={emptyDraftThreadId}
                rightPanelThreadId={panelThreadId}
                threadPanelAnchorRef={threadDetailsAnchorRef}
                onArrange={() => setMaximizedThreadId(null)}
                {...(grid.tree === null
                  ? {}
                  : { detailsOpen: gridDetailsOpen, onToggleDetails: toggleThreadDetails })}
              />
            </WorkspacePageHeader>
          )}
          <GridHost
            grid={grid}
            maximizedThreadId={shownMaximizedThreadId}
            onTreeChange={(tree) => setTree(grid.id, tree)}
            onFocusThread={(threadId) => focusThread(grid.id, threadId)}
            onCloseThread={(threadId) => {
              void closeGridThread({
                gridId: grid.id,
                threadId,
                settle: (id) =>
                  threadActions.settleThread(
                    scopeThreadRef(grid.environmentId as EnvironmentId, id as ThreadId),
                  ),
              }).then((result) => {
                if (
                  result === null ||
                  result._tag !== "Failure" ||
                  isAtomCommandInterrupted(result)
                ) {
                  return;
                }
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to close thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              });
            }}
            onDropThread={(source, targetThreadId, side) => {
              const targetCount = grid.tree === null ? 0 : preorderThreads(grid.tree).length;
              const sourceProjectKey = workspaceKeyOf(source.environmentId, source.projectId);
              if (!sameProject(source, grid)) {
                const sourceTitle = projectTitles.get(sourceProjectKey);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    ...(sourceTitle === undefined
                      ? noProjectMoveToast(grid.name)
                      : crossProjectMoveToast(sourceTitle, projectTitleOf(grid))),
                  }),
                );
                return;
              }
              if (
                side !== "center" &&
                targetCount >= MAX_GRID_THREADS &&
                !visibleThreadIds.has(source.threadId)
              ) {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    ...gridFullMoveToast(grid.name, targetCount, MAX_GRID_THREADS),
                  }),
                );
                return;
              }
              const moved = moveThreadToCell({
                threadId: source.threadId,
                targetGridId: grid.id,
                targetThreadId,
                side,
                threadEnvironmentId: source.environmentId,
                threadProjectId: source.projectId,
              });
              // A thread that came from the sidebar or another grid keeps the
              // user here; the toast offers this grid and the way back.
              if (moved && source.gridId !== grid.id) {
                showThreadMovedToast({
                  threadId: source.threadId,
                  threadEnvironmentId: source.environmentId,
                  threadProjectId: source.projectId,
                  threadTitle:
                    workspaceThreads.find((thread) => thread.id === source.threadId)?.title ?? null,
                  sourceGridId: source.gridId,
                  targetGridId: grid.id,
                  onOpenTarget: (gridId) => {
                    void navigate({ to: "/grid/$gridId", params: { gridId } });
                  },
                });
              }
            }}
            renderThread={({
              node,
              focused,
              maximized,
              onClose,
              onArchiveClose,
              onSplit,
              dragging,
              dropRefusal,
              dropIndicator,
              onDragHandlePointerDown,
            }) => (
              <GridThreadCell
                key={node.id}
                node={node}
                grid={grid}
                focused={focused}
                maximized={maximized}
                availableThreads={availableThreads}
                rightPanelPortal={
                  node.threadId === panelThreadId && rightPanelHost !== null
                    ? {
                        host: rightPanelHost,
                        container: gridRow,
                        headerControls: (
                          <GridRightPanelPin
                            threadTitle={
                              workspaceThreads.find((thread) => thread.id === node.threadId)
                                ?.title ?? "Untitled thread"
                            }
                            pinned={pinnedPanelThreadId === node.threadId}
                            onPinnedChange={(pinned) =>
                              setPanelPinnedThread(grid.id, pinned ? node.threadId : null)
                            }
                          />
                        ),
                      }
                    : null
                }
                threadDetailsAnchor={focused ? threadDetailsAnchorRef : null}
                detailsOpen={gridDetailsOpen && focused}
                onDetailsOpenChange={focused ? closeGridDetails : undefined}
                onToggleDetails={toggleThreadDetails}
                onFocus={() => focusThread(grid.id, node.threadId)}
                onClose={onClose}
                onArchiveClose={onArchiveClose}
                onMaximize={() => {
                  focusThread(grid.id, node.threadId);
                  setMaximizedThreadId(effectiveMaximized === node.threadId ? null : node.threadId);
                }}
                onSplit={onSplit}
                dragging={dragging}
                dropIndicator={dropIndicator}
                dropRefusal={dropRefusal}
                onDragHandlePointerDown={onDragHandlePointerDown}
                swapTargets={gridCells.filter((cell) => cell.threadId !== node.threadId)}
                onSwapWith={(targetThreadId) =>
                  reorderGridThreads(grid.id, node.threadId, targetThreadId)
                }
                onOpenGrid={(targetGridId) => {
                  void navigate({ to: "/grid/$gridId", params: { gridId: targetGridId } });
                }}
                onNewThread={(side) => createThread(side, node.threadId)}
                onOpenThread={(ref, intent) =>
                  openThread(ref.environmentId, ref.threadId, node.threadId, intent)
                }
                onBack={() => void navigate({ to: "/" })}
                phone={phoneThreadPage}
              />
            )}
            renderEmpty={() => (
              <ThreadOpenProvider
                key={grid.id}
                open={(ref, intent) => openThread(ref.environmentId, ref.threadId, null, intent)}
              >
                <GridEmptyDraft
                  grid={grid}
                  threadDetailsAnchor={threadDetailsAnchorRef}
                  onDraftChange={(draft) => setEmptyDraftThreadId(draft?.threadId ?? null)}
                />
              </ThreadOpenProvider>
            )}
          />
          {gridTerminalRef === null ? null : (
            <GridTerminalDock key={grid.id} grid={grid} keybindings={keybindings} />
          )}
        </div>
        <div ref={setRightPanelHost} className="contents" data-grid-right-panel-host="" />
      </div>
    </SidebarInset>
  );
}
