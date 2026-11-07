import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import { EllipsisIcon, Maximize2Icon, Minimize2Icon, SquareMenuIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import ChatView, { type RightPanelPortalTarget } from "../ChatView";
import { resolveThreadStatusPill } from "../Sidebar.logic";

import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadActions } from "../../hooks/useThreadActions";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShell } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { paneDensityLayout } from "../../grid/density";
import { subscribeGridCellRename } from "../../grid/gridCellCommands";
import { gridTerminalThreadRef } from "../../grid/gridTerminal";
import { MAX_GRID_THREADS, type GridRecord, useGridStore } from "../../grid/gridStore";
import type { ThreadDropRefusal } from "../../grid/projectMove";
import { type Side, type SplitSide, type ThreadNode, preorderThreads } from "../../grid/tree";
import { getThreadDragSource } from "../../grid/threadDrag";
import { Button } from "../ui/button";
import { GridDropIndicator } from "../ui/grid-drop-indicator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "../chat/composerFocusRedirect";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { GridPaneHeader } from "../ui/grid-pane-header";
import { ThreadOpenProvider } from "./threadOpenContext";
import { PaneThreadStatusMark } from "./threadStatusMark";
import { usePaneDensity } from "./usePaneDensity";

export function GridThreadCell({
  node,
  grid,
  focused,
  maximized = false,
  availableThreads,
  providerEntries,
  onFocus,
  onClose,
  onArchiveClose,
  onMaximize,
  onSplit,
  onNewThread,
  onOpenThread,
  rightPanelPortal,
  threadDetailsAnchor,
  detailsOpen,
  onDetailsOpenChange,
  onToggleDetails,
  dragging = false,
  dropIndicator = null,
  dropRefusal = null,
  onDragHandlePointerDown,
  swapTargets = [],
  onSwapWith,
  onOpenGrid,
}: {
  node: ThreadNode;
  grid: GridRecord;
  focused: boolean;
  /** This cell is shown alone; the grid tree keeps every other cell. */
  maximized?: boolean;
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  onFocus: () => void;
  onClose: () => void;
  /** Removes the cell without adding it to the reopen stack. */
  onArchiveClose?: (() => void) | undefined;
  onMaximize?: (() => void) | undefined;
  onSplit: (side: SplitSide, threadId: string) => void;
  onNewThread?: ((side: SplitSide) => void) | undefined;
  onOpenThread: (ref: ScopedThreadRef) => void;
  /** The focused cell mounts its thread's right panel beside the grid. */
  rightPanelPortal?: RightPanelPortalTarget | null;
  /** The focused cell anchors its popover details card under the top bar control. */
  threadDetailsAnchor?: RefObject<Element | null> | null;
  /** The grid's one details flag; only the focused cell shows its card. */
  detailsOpen?: boolean;
  onDetailsOpenChange?: ((open: boolean) => void) | undefined;
  /** Toggles the grid's thread-details card from this pane's header. */
  onToggleDetails?: (() => void) | undefined;
  /** The cell's label is being dragged to another cell. */
  dragging?: boolean;
  /** Where a thread dropped on this cell would land. */
  dropIndicator?: Side | null;
  /** The cell refuses the drop, and why. */
  dropRefusal?: ThreadDropRefusal | null;
  /** Starts a pointer drag from the label; absent when the cell cannot move. */
  onDragHandlePointerDown?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  /** The other cells in this grid, for the label's keyboard move action. */
  swapTargets?: ReadonlyArray<{ threadId: string; title: string }>;
  onSwapWith?: ((threadId: string) => void) | undefined;
  /** Opens a grid the shared menu moved this cell's thread to. */
  onOpenGrid?: ((gridId: string) => void) | undefined;
}) {
  const environmentId = grid.environmentId as EnvironmentId;
  const threadId = node.threadId as ThreadId;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const draftId = node.draftId as DraftId | undefined;
  const draftSession = useComposerDraftStore((store) =>
    draftId === undefined ? null : store.getDraftSession(draftId),
  );
  const promoted = useComposerDraftStore((store) =>
    draftId === undefined ? null : store.getPromotedDraftRedirect(draftId),
  );
  const setDraftId = useGridStore((store) => store.setDraftId);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const { renameThread } = useThreadActions();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(shell?.title ?? "");
  const startRename = () => {
    if (draftId !== undefined || shell === null) return;
    setRenameValue(shell.title);
    setRenaming(true);
  };
  const commitRename = () => {
    if (!renaming) return;
    setRenaming(false);
    const title = renameValue.trim();
    if (title.length === 0 || title === shell?.title) return;
    void renameThread(threadRef, title);
  };
  const startRenameStable = useStableCallback(startRename);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- opens the inline rename field when the palette asks this cell to rename its thread
  useEffect(
    () =>
      subscribeGridCellRename((requestedThreadId) => {
        if (requestedThreadId === node.threadId) startRenameStable();
      }),
    [node.threadId, startRenameStable],
  );

  // The draft is promoted by the composer store, not by this cell; this keeps the grid
  // leaf in step so a sent draft stops rendering as a draft.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- syncs the persisted grid leaf with the composer store's promotion.
  useEffect(() => {
    if (draftId !== undefined && draftSession === null && promoted !== null) {
      setDraftId(grid.id, node.threadId, null);
    }
  }, [draftId, draftSession, grid.id, node.threadId, promoted, setDraftId]);

  const status = shell === null ? null : resolveThreadStatusPill({ thread: shell });
  const title = draftId !== undefined ? "New thread" : (shell?.title ?? "Untitled thread");
  const showDraft = draftId !== undefined && draftSession !== null;
  const threadCount = grid.tree === null ? 0 : preorderThreads(grid.tree).length;
  // A maximized cell is a solo thread: one thread, the widest measure.
  const measuredThreadCount = maximized ? 1 : threadCount;
  const { ref, density, width } = usePaneDensity(measuredThreadCount);
  const layout = paneDensityLayout(density, width);
  const closeArchivedCell = onArchiveClose ?? onClose;
  // A grid holds six threads; the sixth cell still offers "New thread", whose
  // handler asks before moving the new thread to its own grid.
  const availableForSplit = threadCount >= MAX_GRID_THREADS ? [] : availableThreads;
  const moveTargets = onSwapWith === undefined ? [] : swapTargets;
  const showSplit = availableThreads.length > 0 || onNewThread !== undefined;
  const showOverflow = shell !== null || showSplit || moveTargets.length > 0;
  const canRename = draftId === undefined && shell !== null;
  const archived = useArchivedThreadSnapshots([environmentId]);
  const closeCellStable = useStableCallback(closeArchivedCell);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  // A pointer press outside an open details card closes it before the click lands; the click
  // must not immediately reopen it.
  const detailsWasOpenRef = useRef(false);
  const { openMenu } = useThreadActionMenu({
    threadRef,
    thread: shell,
    onStartRename: startRename,
    grid: {
      currentGridId: grid.id,
      isFocusedCell: focused,
      onOpen: onFocus,
      ...(onOpenGrid === undefined ? {} : { onOpenGrid }),
    },
    cell: {
      split: showSplit
        ? {
            availableThreads: availableForSplit,
            atCap: threadCount >= MAX_GRID_THREADS,
            onPick: onSplit,
            ...(onNewThread === undefined ? {} : { onNewThread }),
          }
        : null,
      swapTargets: moveTargets,
      ...(onSwapWith === undefined ? {} : { onSwapWith }),
    },
    onThreadArchived: closeArchivedCell,
  });
  const openMoreMenu = () => {
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect === undefined || rect === null) return;
    void openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- drops a cell whose thread was archived elsewhere (the sidebar or another window)
  useEffect(() => {
    if (draftId !== undefined) return;
    const archivedIds = new Set<string>(
      archived.snapshots.flatMap((entry) =>
        entry.snapshot.threads.map((thread) => String(thread.id)),
      ),
    );
    if (archivedIds.has(node.threadId)) closeCellStable();
  }, [archived.snapshots, draftId, node.threadId, closeCellStable]);
  const discardDraft = () => {
    if (draftId !== undefined) clearDraftThread(draftId);
    onClose();
  };
  const discardDraftStable = useStableCallback(discardDraft);
  const paneActions = (includeMaximize: boolean) => (
    <>
      {onToggleDetails !== undefined ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={(node) => {
                  if (threadDetailsAnchor) threadDetailsAnchor.current = node;
                }}
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Toggle thread details"
                aria-pressed={focused && detailsOpen === true}
                onPointerDown={() => {
                  detailsWasOpenRef.current = focused && detailsOpen === true;
                }}
                onClick={() => {
                  const stillOpen =
                    useGridStore.getState().grids.find((entry) => entry.id === grid.id)
                      ?.detailsOpen === true;
                  // A popover closed itself on the pointerdown outside it; do not reopen it.
                  if (detailsWasOpenRef.current && !stillOpen) {
                    detailsWasOpenRef.current = false;
                    return;
                  }
                  detailsWasOpenRef.current = false;
                  onToggleDetails();
                }}
              />
            }
          >
            <SquareMenuIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Thread details</TooltipPopup>
        </Tooltip>
      ) : null}
      {includeMaximize && onMaximize !== undefined ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={maximized ? "Restore cell" : "Maximize cell"}
                onClick={onMaximize}
              />
            }
          >
            {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{maximized ? "Restore cell" : "Maximize cell"}</TooltipPopup>
        </Tooltip>
      ) : null}
      {showOverflow ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={moreButtonRef}
                variant="ghost-muted"
                size="icon-sm"
                aria-label="More cell actions"
                aria-haspopup="menu"
                onClick={openMoreMenu}
              />
            }
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">More cell actions</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={draftId === undefined ? "Close thread" : "Close cell"}
              onClick={discardDraft}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {draftId === undefined ? "Close thread" : "Close cell"}
        </TooltipPopup>
      </Tooltip>
    </>
  );
  // A new draft pane opens with its composer focused; ChatView skips that
  // autofocus while embedded, so the cell asks the mounted editor itself.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- focuses the draft editor once the embedded composer has mounted
  useEffect(() => {
    if (draftId === undefined || !focused) return;
    let frame = 0;
    let attempts = 0;
    const focusEditor = () => {
      const cell = ref.current;
      if (cell === null) return;
      const editor = [
        ...cell.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea'),
      ].find((candidate) => candidate.getClientRects().length > 0);
      if (editor !== undefined) {
        editor.focus({ preventScroll: true });
        return;
      }
      if (attempts < 12) {
        attempts += 1;
        frame = window.requestAnimationFrame(focusEditor);
      }
    };
    frame = window.requestAnimationFrame(focusEditor);
    return () => window.cancelAnimationFrame(frame);
  }, [draftId, focused, ref]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- window Escape listener discards this draft pane before the composer consumes the key
  useEffect(() => {
    if (draftId === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Escape cancels a cell drag; it must not also discard the draft that is being dragged.
      if (getThreadDragSource() !== null) return;
      if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      discardDraftStable();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [draftId, discardDraftStable]);

  return (
    <section
      ref={ref}
      data-grid-cell=""
      data-density={density}
      data-thread-id={node.threadId}
      data-focused={focused ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      style={
        {
          "--chat-content-max-width":
            layout.timelineMaxWidth === null
              ? "100%"
              : `${layout.composerMaxWidth ?? layout.timelineMaxWidth}px`,
          ...(dragging ? { opacity: 0.45 } : {}),
        } as CSSProperties
      }
      className={cn(
        "@container/pane group/pane relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden",
        density === "glance" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-changed-files-state=tree]]:hidden [&_[data-changed-files-bar]]:hidden",
      )}
    >
      <GridPaneHeader
        title={title}
        status={shell === null ? null : <PaneThreadStatusMark thread={shell} status={status} />}
        providerStack={
          shell === null ? null : (
            <SidebarProviderStack thread={shell} providerEntryByInstanceId={providerEntries} />
          )
        }
        focused={focused}
        renaming={renaming}
        renameValue={renameValue}
        onChangeRename={setRenameValue}
        onCommitRename={commitRename}
        onCancelRename={() => setRenaming(false)}
        onDoubleClickTitle={canRename ? startRename : undefined}
        onDragHandlePointerDown={onDragHandlePointerDown}
        actions={paneActions(true)}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ThreadOpenProvider open={onOpenThread}>
          {showDraft ? (
            <ChatView
              embedded
              shortcutsAtWindow={focused}
              visitActive={focused}
              gridTerminalRef={maximized ? null : gridTerminalThreadRef(environmentId, grid.id)}
              draftId={draftId}
              environmentId={environmentId}
              threadId={threadId}
              paneDensity={density}
              rightPanelPortal={rightPanelPortal}
              {...(threadDetailsAnchor ? { detailsCardAnchor: threadDetailsAnchor } : {})}
              {...(detailsOpen === undefined ? {} : { detailsOpen })}
              {...(onDetailsOpenChange === undefined ? {} : { onDetailsOpenChange })}
              routeKind="draft"
            />
          ) : (
            <ChatView
              embedded
              shortcutsAtWindow={focused}
              visitActive={focused}
              gridTerminalRef={maximized ? null : gridTerminalThreadRef(environmentId, grid.id)}
              environmentId={environmentId}
              threadId={threadId}
              paneDensity={density}
              rightPanelPortal={rightPanelPortal}
              {...(threadDetailsAnchor ? { detailsCardAnchor: threadDetailsAnchor } : {})}
              {...(detailsOpen === undefined ? {} : { detailsOpen })}
              {...(onDetailsOpenChange === undefined ? {} : { onDetailsOpenChange })}
              routeKind="server"
            />
          )}
        </ThreadOpenProvider>
      </div>
      {dropRefusal !== null ? (
        <GridDropIndicator refusal={dropRefusal} />
      ) : dropIndicator === null ? null : (
        <GridDropIndicator side={dropIndicator} />
      )}
    </section>
  );
}
