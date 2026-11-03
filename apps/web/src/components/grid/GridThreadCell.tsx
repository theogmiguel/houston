import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@houston-app/contracts";
import { EllipsisIcon, Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type RefObject } from "react";

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
import { MAX_GRID_THREADS, type GridRecord, useGridStore } from "../../grid/gridStore";
import type { MoveToGridTarget } from "../../grid/moveToGrid";
import { type Side, type SplitSide, type ThreadNode, preorderThreads } from "../../grid/tree";
import type { ThreadDragHandleProps, ThreadDropTargetProps } from "../../grid/threadDrag";
import { Button } from "../ui/button";
import { GridPaneActions, GridPaneRename, GridPaneRenameInput } from "../ui/grid-pane";
import { GridDropIndicator } from "../ui/grid-drop-indicator";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "../chat/composerFocusRedirect";
import { MoveToGridMenuItems } from "./MoveToGridMenuItems";
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
  dragHandleProps,
  dropTargetProps,
  swapTargets = [],
  onSwapWith,
  gridTargets = [],
  onMoveToGrid,
  onMoveToNewGrid,
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
  dragHandleProps?: ThreadDragHandleProps;
  dropTargetProps?: ThreadDropTargetProps;
  /** The other cells in this grid, for the label's keyboard move action. */
  swapTargets?: ReadonlyArray<{ threadId: string; title: string }>;
  onSwapWith?: ((threadId: string) => void) | undefined;
  /** The project's other grids, for the cell menu's Move to grid action. */
  gridTargets?: ReadonlyArray<MoveToGridTarget>;
  onMoveToGrid?: ((gridId: string) => void) | undefined;
  onMoveToNewGrid?: (() => void) | undefined;
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
  const {
    archiveThread,
    markThreadUnread,
    confirmAndDeleteThread,
    renameThread,
    regenerateThreadTitle,
    copyThreadId,
    copyThreadPath,
    copyThreadBranch,
    copyThreadRef,
    findThread,
    openThreadProjectSettings,
    threadSnoozePresets,
    holdThread,
    closeThread,
  } = useThreadActions();
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

  const regenerateTitle = () => {
    void regenerateThreadTitle(threadRef);
  };
  const deleteThread = () => {
    void confirmAndDeleteThread(threadRef);
  };

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
  const canArchive = draftId === undefined;
  const showSplit = availableThreads.length > 0 || onNewThread !== undefined;
  const showOverflow =
    showSplit || moveTargets.length > 0 || onMoveToGrid !== undefined || canArchive;
  const archived = useArchivedThreadSnapshots([environmentId]);
  const closeCellStable = useStableCallback(closeArchivedCell);
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
  const canRename = draftId === undefined && shell !== null;
  const snoozePresets = canRename ? threadSnoozePresets(threadRef) : [];
  const paneActions = (includeMaximize: boolean) => (
    <>
      {showOverflow ? (
        <MoreCellMenu
          split={
            showSplit
              ? {
                  availableThreads: availableForSplit,
                  atCap: threadCount >= MAX_GRID_THREADS,
                  onPick: onSplit,
                  onNewThread,
                }
              : null
          }
          targets={moveTargets}
          onPick={onSwapWith}
          gridTargets={gridTargets}
          onMoveToGrid={onMoveToGrid}
          onMoveToNewGrid={onMoveToNewGrid}
          onArchive={
            canArchive
              ? () => void archiveThread(threadRef, { onArchived: closeArchivedCell })
              : undefined
          }
          onRename={canRename ? startRename : undefined}
          onMarkUnread={canRename ? () => markThreadUnread(threadRef) : undefined}
          onCopyPath={canRename ? () => void copyThreadPath(threadRef) : undefined}
          onCopyBranch={canRename ? () => void copyThreadBranch(threadRef) : undefined}
          onCopyThreadRef={canRename ? () => void copyThreadRef(threadRef) : undefined}
          onCopyThreadId={canRename ? () => void copyThreadId(threadRef) : undefined}
          onFind={canRename ? () => findThread(threadRef) : undefined}
          onProjectSettings={
            canRename ? () => void openThreadProjectSettings(threadRef) : undefined
          }
          snoozePresets={snoozePresets}
          onHold={(snoozedUntil) => void holdThread(threadRef, snoozedUntil)}
          onClose={canRename ? () => void closeThread(threadRef) : undefined}
          onRegenerateTitle={canRename ? regenerateTitle : undefined}
          onDelete={canRename ? deleteThread : undefined}
        />
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
            <Maximize2Icon />
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
              aria-label="Close cell"
              onClick={discardDraft}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close cell</TooltipPopup>
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
      {...dropTargetProps}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      style={
        {
          "--chat-content-max-width":
            layout.timelineMaxWidth === null
              ? "100%"
              : `${layout.composerMaxWidth ?? layout.timelineMaxWidth}px`,
          ...(density === "solo" ? { "--text-prose--line-height": "1.3125rem" } : {}),
          ...(showLabel ? { "--pane-label-inset": "2.625rem" } : {}),
          ...(dragging ? { opacity: 0.45 } : {}),
        } as CSSProperties
      }
      className={cn(
        "group/pane relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden",
        density === "solo" && "[&_.chat-content-lane]:max-w-[45rem]",
        // A composer drawer keeps the stacked card: the compact row would squeeze the
        // question panel and textarea into zero-width flex columns.
        density === "compact" &&
          "[&_[data-thread-find-text]]:line-clamp-5 [&_[data-chat-composer-resting-row]]:hidden [&_[data-chat-composer-surface]:not(:has([data-chat-composer-top-drawer]))]:flex [&_[data-chat-composer-surface]:not(:has([data-chat-composer-top-drawer]))]:items-center [&_[data-chat-composer-body]]:min-w-0 [&_[data-chat-composer-body]]:flex-1 [&_[data-chat-composer-body]]:pt-2 [&_[data-chat-composer-body]]:pb-2 [&_[data-chat-composer-footer]]:w-auto [&_[data-chat-composer-footer]]:shrink-0 [&_[data-chat-composer-footer]]:pb-2",
        density === "glance" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-thread-find-text]]:line-clamp-3 [&_[data-changed-files-state=tree]]:hidden [&_[data-changed-files-bar]]:hidden",
      )}
    >
      {showLabel ? (
        <div
          data-pane-label=""
          {...dragHandleProps}
          style={dragHandleProps?.draggable === true ? { cursor: "grab" } : undefined}
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
          <SidebarThreadStatusGlyph status={status} label={status?.label} />
          <div className="flex max-w-0 items-center gap-0.5 overflow-hidden opacity-0 transition-[max-width,opacity] duration-150 ease-out group-hover/pane:max-w-40 group-hover/pane:opacity-100 group-focus-within/label:max-w-40 group-focus-within/label:opacity-100 motion-reduce:transition-none">
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
          <GridPaneActions>{paneActions(false)}</GridPaneActions>
        </>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-(--pane-label-inset)">
        <ThreadOpenProvider open={onOpenThread}>
          {showDraft ? (
            <ChatView
              embedded
              shortcutsAtWindow={focused}
              visitActive={focused}
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
      {dropIndicator === null ? null : <GridDropIndicator side={dropIndicator} />}
    </section>
  );
}

const SPLIT_CHOICES = [
  { side: "right", label: "Split right" },
  { side: "bottom", label: "Split down" },
] as const satisfies ReadonlyArray<{ side: SplitSide; label: string }>;

interface SplitChoices {
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
  atCap: boolean;
  onPick: (side: SplitSide, threadId: string) => void;
  onNewThread?: ((side: SplitSide) => void) | undefined;
}

/** The cell's one overflow menu: split, move, then archive, each group apart. */
function MoreCellMenu({
  split,
  targets,
  onPick,
  gridTargets,
  onMoveToGrid,
  onMoveToNewGrid,
  onArchive,
  onRename,
  onMarkUnread,
  onCopyPath,
  onCopyBranch,
  onCopyThreadRef,
  onCopyThreadId,
  onFind,
  onProjectSettings,
  snoozePresets,
  onHold,
  onClose,
  onRegenerateTitle,
  onDelete,
}: {
  split: SplitChoices | null;
  targets: ReadonlyArray<{ threadId: string; title: string }>;
  onPick?: ((threadId: string) => void) | undefined;
  gridTargets: ReadonlyArray<MoveToGridTarget>;
  onMoveToGrid?: ((gridId: string) => void) | undefined;
  onMoveToNewGrid?: (() => void) | undefined;
  onArchive?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  onMarkUnread?: (() => void) | undefined;
  onCopyPath?: (() => void) | undefined;
  onCopyBranch?: (() => void) | undefined;
  onCopyThreadRef?: (() => void) | undefined;
  onCopyThreadId?: (() => void) | undefined;
  onFind?: (() => void) | undefined;
  onProjectSettings?: (() => void) | undefined;
  snoozePresets?:
    | ReadonlyArray<{ id: string; label: string; whenLabel: string; snoozedUntil: string }>
    | undefined;
  onHold?: ((snoozedUntil: string) => void) | undefined;
  onClose?: (() => void) | undefined;
  onRegenerateTitle?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const hasThreadActions =
    onRename !== undefined ||
    onMarkUnread !== undefined ||
    onCopyPath !== undefined ||
    onFind !== undefined ||
    onProjectSettings !== undefined ||
    (snoozePresets?.length ?? 0) > 0 ||
    onClose !== undefined ||
    onRegenerateTitle !== undefined ||
    onDelete !== undefined;
  const groups = [
    split === null ? null : "split",
    targets.length === 0 ? null : "move",
    onMoveToGrid === undefined ? null : "grid",
    hasThreadActions ? "thread" : null,
    onArchive === undefined ? null : "archive",
  ].filter((group) => group !== null);
  const separatorBefore = (group: string) => groups.indexOf(group) > 0;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost-muted" size="icon-sm" aria-label="More cell actions" />
              }
            />
          }
        >
          <EllipsisIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">More cell actions</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="start">
        {split === null
          ? null
          : SPLIT_CHOICES.map(({ side, label }) => (
              <MenuSub key={side}>
                <MenuSubTrigger>{label}</MenuSubTrigger>
                <MenuSubPopup>
                  <SplitTargetItems
                    availableThreads={split.availableThreads}
                    atCap={split.atCap}
                    onPick={(threadId) => {
                      setOpen(false);
                      split.onPick(side, threadId);
                    }}
                    onNewThread={
                      split.onNewThread === undefined
                        ? undefined
                        : () => {
                            setOpen(false);
                            split.onNewThread?.(side);
                          }
                    }
                  />
                </MenuSubPopup>
              </MenuSub>
            ))}
        {targets.length === 0 ? null : (
          <>
            {separatorBefore("move") ? <MenuSeparator /> : null}
            <MenuSub>
              <MenuSubTrigger>Move to…</MenuSubTrigger>
              <MenuSubPopup>
                {targets.map((target) => (
                  <MenuItem
                    key={target.threadId}
                    onClick={() => {
                      setOpen(false);
                      onPick?.(target.threadId);
                    }}
                  >
                    Swap with {target.title}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          </>
        )}
        {onMoveToGrid === undefined ? null : (
          <>
            {separatorBefore("grid") ? <MenuSeparator /> : null}
            <MenuSub>
              <MenuSubTrigger>Move to grid</MenuSubTrigger>
              <MenuSubPopup>
                <MoveToGridMenuItems
                  targets={gridTargets}
                  onMove={(gridId) => {
                    setOpen(false);
                    onMoveToGrid(gridId);
                  }}
                  onNewGrid={() => {
                    setOpen(false);
                    onMoveToNewGrid?.();
                  }}
                />
              </MenuSubPopup>
            </MenuSub>
          </>
        )}
        {hasThreadActions ? (
          <>
            {separatorBefore("thread") ? <MenuSeparator /> : null}
            {onRename === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onRename();
                }}
              >
                Rename thread
              </MenuItem>
            )}
            {onMarkUnread === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onMarkUnread();
                }}
              >
                Mark unread
              </MenuItem>
            )}
            {onCopyPath === undefined &&
            onCopyBranch === undefined &&
            onCopyThreadRef === undefined &&
            onCopyThreadId === undefined ? null : (
              <MenuSub>
                <MenuSubTrigger>Copy</MenuSubTrigger>
                <MenuSubPopup>
                  {onCopyPath === undefined ? null : (
                    <MenuItem
                      onClick={() => {
                        setOpen(false);
                        onCopyPath();
                      }}
                    >
                      Copy path
                    </MenuItem>
                  )}
                  {onCopyBranch === undefined ? null : (
                    <MenuItem
                      onClick={() => {
                        setOpen(false);
                        onCopyBranch();
                      }}
                    >
                      Copy branch
                    </MenuItem>
                  )}
                  {onCopyThreadRef === undefined ? null : (
                    <MenuItem
                      onClick={() => {
                        setOpen(false);
                        onCopyThreadRef();
                      }}
                    >
                      Copy thread reference
                    </MenuItem>
                  )}
                  {onCopyThreadId === undefined ? null : (
                    <MenuItem
                      onClick={() => {
                        setOpen(false);
                        onCopyThreadId();
                      }}
                    >
                      Copy thread ID
                    </MenuItem>
                  )}
                </MenuSubPopup>
              </MenuSub>
            )}
            {onFind === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onFind();
                }}
              >
                Find in thread
              </MenuItem>
            )}
            {onProjectSettings === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onProjectSettings();
                }}
              >
                Project settings
              </MenuItem>
            )}
            {onHold === undefined || (snoozePresets?.length ?? 0) === 0 ? null : (
              <MenuSub>
                <MenuSubTrigger>Hold</MenuSubTrigger>
                <MenuSubPopup>
                  {snoozePresets?.map((preset) => (
                    <MenuItem
                      key={preset.id}
                      onClick={() => {
                        setOpen(false);
                        onHold(preset.snoozedUntil);
                      }}
                    >
                      {preset.label}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            )}
            {onClose === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onClose();
                }}
              >
                Close thread
              </MenuItem>
            )}
            {onRegenerateTitle === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onRegenerateTitle();
                }}
              >
                Regenerate title
              </MenuItem>
            )}
            {onDelete === undefined ? null : (
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
              >
                Delete thread
              </MenuItem>
            )}
          </>
        ) : null}
        {onArchive === undefined ? null : (
          <>
            {separatorBefore("archive") ? <MenuSeparator /> : null}
            <MenuItem
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
            >
              Archive thread
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function SplitTargetItems({
  availableThreads,
  atCap,
  onPick,
  onNewThread,
}: {
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
  atCap: boolean;
  onPick: (threadId: string) => void;
  onNewThread?: (() => void) | undefined;
}) {
  return (
    <>
      {availableThreads.map((thread) => (
        <MenuItem key={thread.threadId} onClick={() => onPick(thread.threadId)}>
          {thread.title}
        </MenuItem>
      ))}
      {availableThreads.length === 0 ? (
        <MenuItem disabled>
          {atCap ? "This grid holds six threads" : "No other thread in this workspace"}
        </MenuItem>
      ) : null}
      {onNewThread === undefined ? null : (
        <>
          <MenuSeparator />
          <MenuItem onClick={onNewThread}>New thread…</MenuItem>
        </>
      )}
    </>
  );
}
