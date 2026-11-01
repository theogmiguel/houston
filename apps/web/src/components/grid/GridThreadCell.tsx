import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowRightLeftIcon,
  Maximize2Icon,
  XIcon,
} from "lucide-react";
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
import { MAX_GRID_THREADS, type GridRecord, useGridStore } from "../../grid/gridStore";
import { type Side, type SplitSide, type ThreadNode, preorderThreads } from "../../grid/tree";
import type { ThreadDragHandleProps, ThreadDropTargetProps } from "../../grid/threadDrag";
import { Button } from "../ui/button";
import { GridDropIndicator } from "../ui/grid-drop-indicator";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { cn } from "../../lib/utils";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "../chat/composerFocusRedirect";
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
  const { archiveThread } = useThreadActions();

  // The draft is promoted by the composer store, not by this cell; this keeps the grid
  // leaf in step so a sent draft stops rendering as a draft.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs the persisted grid leaf with the composer store's promotion.
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
  const archived = useArchivedThreadSnapshots([environmentId]);
  const closeCellStable = useStableCallback(closeArchivedCell);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops a cell whose thread was archived elsewhere (the sidebar or another window)
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
  // A new draft pane opens with its composer focused; ChatView skips that
  // autofocus while embedded, so the cell asks the mounted editor itself.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the draft editor once the embedded composer has mounted
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window Escape listener discards this draft pane before the composer consumes the key
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
        "group/pane relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-pane",
        density === "solo" && "[&_.chat-content-lane]:max-w-[45rem]",
        density === "compact" &&
          "[&_[data-thread-find-text]]:line-clamp-5 [&_[data-chat-composer-resting-row]]:hidden [&_[data-chat-composer-surface]]:flex [&_[data-chat-composer-surface]]:items-center [&_[data-chat-composer-body]]:min-w-0 [&_[data-chat-composer-body]]:flex-1 [&_[data-chat-composer-body]]:pt-2 [&_[data-chat-composer-body]]:pb-2 [&_[data-chat-composer-footer]]:w-auto [&_[data-chat-composer-footer]]:shrink-0 [&_[data-chat-composer-footer]]:pb-2",
        density === "glance" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-thread-find-text]]:line-clamp-3 [&_[data-changed-files-state=tree]]:hidden [&_[data-changed-files-bar]]:hidden",
      )}
    >
      {showLabel ? (
        <div
          data-pane-label=""
          {...dragHandleProps}
          style={dragHandleProps?.draggable === true ? { cursor: "grab" } : undefined}
          className="group/label absolute top-2 left-2 z-20 flex h-[26px] max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-(--r-ctl) border border-(--divider) bg-(--pane) ps-2 pe-1 shadow-[var(--shadow-1)]"
        >
          <span className="grid size-3.5 shrink-0 place-items-center">
            {shell !== null ? (
              <SidebarProviderStack thread={shell} providerEntryByInstanceId={providerEntries} />
            ) : null}
          </span>
          <span
            className={cn(
              "max-w-48 min-w-0 truncate text-xs leading-4 font-medium",
              focused ? "text-(--t1)" : "text-(--t3)",
            )}
          >
            {title}
          </span>
          <SidebarThreadStatusGlyph status={status} label={status?.label} />
          <div className="flex max-w-0 items-center gap-0.5 overflow-hidden opacity-0 transition-[max-width,opacity] duration-150 ease-out group-hover/pane:max-w-40 group-hover/pane:opacity-100 group-focus-within/label:max-w-40 group-focus-within/label:opacity-100 motion-reduce:transition-none">
            {availableThreads.length > 0 || onNewThread !== undefined ? (
              <>
                <SplitMenu
                  side="right"
                  availableThreads={availableForSplit}
                  atCap={threadCount >= MAX_GRID_THREADS}
                  onPick={(pickedThreadId) => onSplit("right", pickedThreadId)}
                  onNewThread={onNewThread === undefined ? undefined : () => onNewThread("right")}
                />
                <SplitMenu
                  side="bottom"
                  availableThreads={availableForSplit}
                  atCap={threadCount >= MAX_GRID_THREADS}
                  onPick={(pickedThreadId) => onSplit("bottom", pickedThreadId)}
                  onNewThread={onNewThread === undefined ? undefined : () => onNewThread("bottom")}
                />
              </>
            ) : null}
            {onSwapWith === undefined || swapTargets.length === 0 ? null : (
              <MoveCellMenu targets={swapTargets} onPick={onSwapWith} />
            )}
            {draftId === undefined ? (
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Archive thread"
                onClick={() => void archiveThread(threadRef, { onArchived: closeArchivedCell })}
              >
                <ArchiveIcon />
              </Button>
            ) : null}
            {onMaximize === undefined ? null : (
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={maximized ? "Restore cell" : "Maximize cell"}
                onClick={onMaximize}
              >
                <Maximize2Icon />
              </Button>
            )}
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Close cell"
              onClick={discardDraft}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-(--pane-label-inset)">
        <ThreadOpenProvider open={onOpenThread}>
          {showDraft ? (
            <ChatView
              embedded
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

function MoveCellMenu({
  targets,
  onPick,
}: {
  targets: ReadonlyArray<{ threadId: string; title: string }>;
  onPick: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button variant="ghost-muted" size="icon-sm" aria-label="Move cell">
            <ArrowRightLeftIcon />
          </Button>
        }
      />
      <MenuPopup side="bottom" align="end">
        {targets.map((target) => (
          <MenuItem
            key={target.threadId}
            onClick={() => {
              setOpen(false);
              onPick(target.threadId);
            }}
          >
            Swap with {target.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SplitMenu({
  side,
  availableThreads,
  atCap,
  onPick,
  onNewThread,
}: {
  side: SplitSide;
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
  atCap: boolean;
  onPick: (threadId: string) => void;
  onNewThread?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const horizontal = side === "right";
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={horizontal ? "Split cell right" : "Split cell down"}
          >
            {horizontal ? <ArrowRightIcon /> : <ArrowDownIcon />}
          </Button>
        }
      />
      <MenuPopup side="bottom" align="end">
        {availableThreads.map((thread) => (
          <MenuItem
            key={thread.threadId}
            onClick={() => {
              setOpen(false);
              onPick(thread.threadId);
            }}
          >
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
            <MenuItem
              onClick={() => {
                setOpen(false);
                onNewThread();
              }}
            >
              New thread…
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
