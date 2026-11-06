import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import { EllipsisIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
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
import { SidebarThreadStatusGlyph } from "../sidebar/SidebarStatusGlyph";
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
import { GridPaneActions, GridPaneRename, GridPaneRenameInput } from "../ui/grid-pane";
import { PANE_THREAD_TAG_CLASS, PANE_THREAD_TAG_COUNT_CLASS } from "../ui/thread-tag-recipes";
import { GridDropIndicator } from "../ui/grid-drop-indicator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "../chat/composerFocusRedirect";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { ThreadOpenProvider } from "./threadOpenContext";
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
  const showLabel = draftId !== undefined || (threadCount > 1 && !maximized);
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
          ...(showLabel ? { "--pane-label-inset": "2.625rem" } : {}),
          ...(dragging ? { opacity: 0.45 } : {}),
        } as CSSProperties
      }
      className={cn(
        "group/pane relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden",
        density === "solo" && "[&_.chat-content-lane]:max-w-[45rem]",
        // A composer drawer or notice keeps the stacked card: the compact row would squeeze
        // the question panel, the notices and the textarea into zero-width flex columns.
        density === "compact" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-chat-composer-surface]:not(:has([data-chat-composer-top-drawer],[data-composer-banner-shelf]))]:flex [&_[data-chat-composer-surface]:not(:has([data-chat-composer-top-drawer],[data-composer-banner-shelf]))]:items-center [&_[data-chat-composer-body]]:min-w-0 [&_[data-chat-composer-body]]:flex-1 [&_[data-chat-composer-body]]:pt-2 [&_[data-chat-composer-body]]:pb-2 [&_[data-chat-composer-footer]]:w-auto [&_[data-chat-composer-footer]]:shrink-0 [&_[data-chat-composer-footer]]:pb-2",
        density === "glance" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-changed-files-state=tree]]:hidden [&_[data-changed-files-bar]]:hidden",
      )}
    >
      {showLabel ? (
        <div
          data-pane-label=""
          onPointerDown={onDragHandlePointerDown}
          style={onDragHandlePointerDown === undefined ? undefined : { cursor: "grab" }}
          className="group/label absolute top-2 left-2 z-20 flex h-(--h-pill) max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-(--r-selection) border border-(--divider) bg-(--pane-head) ps-2 pe-1"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">
            {shell !== null ? (
              <SidebarProviderStack thread={shell} providerEntryByInstanceId={providerEntries} />
            ) : null}
          </span>
          {renaming ? (
            <GridPaneRenameInput
              value={renameValue}
              onChange={setRenameValue}
              onCommit={commitRename}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span
              onDoubleClick={canRename ? startRename : undefined}
              className={cn(
                "max-w-48 min-w-0 truncate text-xs leading-4 font-medium",
                focused ? "text-(--t1)" : "text-(--houston)",
              )}
            >
              {title}
            </span>
          )}
          {shell !== null && (shell.tags?.length ?? 0) > 0 ? (
            <span data-pane-tags="" className="flex shrink-0 items-center gap-1">
              {(shell.tags ?? []).slice(0, 2).map((tag) => (
                <span key={tag} className={PANE_THREAD_TAG_CLASS}>
                  {tag}
                </span>
              ))}
              {(shell.tags?.length ?? 0) > 2 ? (
                <span className={PANE_THREAD_TAG_COUNT_CLASS}>
                  +{(shell.tags?.length ?? 0) - 2}
                </span>
              ) : null}
            </span>
          ) : null}
          <SidebarThreadStatusGlyph status={status} label={status?.label} />
          <div className="flex w-0 items-center gap-0.5 overflow-hidden opacity-0 [interpolate-size:allow-keywords] transition-[width,opacity] duration-(--motion-disclosure) ease-standard group-hover/pane:w-auto group-hover/pane:opacity-100 group-focus-within/label:w-auto group-focus-within/label:opacity-100 motion-reduce:transition-none">
            {paneActions(true)}
          </div>
        </div>
      ) : (
        <>
          {renaming ? (
            <GridPaneRename>
              <GridPaneRenameInput
                value={renameValue}
                onChange={setRenameValue}
                onCommit={commitRename}
                onCancel={() => setRenaming(false)}
              />
            </GridPaneRename>
          ) : null}
          {/* A maximized cell has no label, so its way back sits with the other actions. */}
          <GridPaneActions>{paneActions(maximized)}</GridPaneActions>
        </>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-(--pane-label-inset)">
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
