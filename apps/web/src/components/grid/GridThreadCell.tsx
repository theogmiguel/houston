import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ArchiveIcon, ArrowDownIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import ChatView from "../ChatView";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { SidebarThreadStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { SidebarProviderStack, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadActions } from "../../hooks/useThreadActions";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShell } from "../../state/entities";
import { paneDensityLayout } from "../../grid/density";
import { type GridRecord, useGridStore } from "../../grid/gridStore";
import { type SplitSide, type ThreadNode, preorderThreads } from "../../grid/tree";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { cn } from "../../lib/utils";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "../chat/composerFocusRedirect";
import { ThreadOpenProvider } from "./threadOpenContext";
import { usePaneDensity } from "./usePaneDensity";

export function GridThreadCell({
  node,
  grid,
  focused,
  availableThreads,
  providerEntries,
  onFocus,
  onClose,
  onSplit,
  onNewThread,
  onOpenThread,
}: {
  node: ThreadNode;
  grid: GridRecord;
  focused: boolean;
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
  providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
  onFocus: () => void;
  onClose: () => void;
  onSplit: (side: SplitSide, threadId: string) => void;
  onNewThread?: ((side: SplitSide) => void) | undefined;
  onOpenThread: (ref: ScopedThreadRef) => void;
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
  const { ref, density, width } = usePaneDensity(threadCount);
  const layout = paneDensityLayout(density, width);
  const discardDraft = () => {
    if (draftId !== undefined) clearDraftThread(draftId);
    onClose();
  };
  const discardDraftStable = useStableCallback(discardDraft);
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
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      style={
        {
          "--chat-content-max-width":
            layout.timelineMaxWidth === null
              ? "100%"
              : `${layout.composerMaxWidth ?? layout.timelineMaxWidth}px`,
          ...(density === "solo" ? { "--text-prose--line-height": "1.3125rem" } : {}),
          ...(threadCount > 1 || draftId !== undefined ? { "--pane-label-inset": "2.625rem" } : {}),
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
      {threadCount > 1 || draftId !== undefined ? (
        <div
          data-pane-label=""
          className="group/label absolute top-2 left-2 z-20 flex h-[26px] max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-(--r-ctl) border border-(--divider) bg-(--pane-head) ps-2 pe-1 shadow-[var(--shadow-1)]"
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
                  availableThreads={availableThreads}
                  onPick={(pickedThreadId) => onSplit("right", pickedThreadId)}
                  onNewThread={onNewThread === undefined ? undefined : () => onNewThread("right")}
                />
                <SplitMenu
                  side="bottom"
                  availableThreads={availableThreads}
                  onPick={(pickedThreadId) => onSplit("bottom", pickedThreadId)}
                  onNewThread={onNewThread === undefined ? undefined : () => onNewThread("bottom")}
                />
              </>
            ) : null}
            {draftId === undefined ? (
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="Archive thread"
                onClick={() => void archiveThread(threadRef, {})}
              >
                <ArchiveIcon />
              </Button>
            ) : null}
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
              routeKind="draft"
            />
          ) : (
            <ChatView
              embedded
              environmentId={environmentId}
              threadId={threadId}
              paneDensity={density}
              routeKind="server"
            />
          )}
        </ThreadOpenProvider>
      </div>
    </section>
  );
}

function SplitMenu({
  side,
  availableThreads,
  onPick,
  onNewThread,
}: {
  side: SplitSide;
  availableThreads: ReadonlyArray<{ threadId: string; title: string }>;
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
          <MenuItem disabled>No other thread in this workspace</MenuItem>
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
