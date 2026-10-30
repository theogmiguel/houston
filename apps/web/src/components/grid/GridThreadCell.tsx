import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ArchiveIcon, ArrowDownIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import ChatView from "../ChatView";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { useThreadActions } from "../../hooks/useThreadActions";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useQuietThreadShell } from "../../state/entities";
import { paneDensityLayout } from "../../grid/density";
import { type GridRecord, useGridStore } from "../../grid/gridStore";
import { type SplitSide, type ThreadNode, preorderThreads } from "../../grid/tree";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { cn } from "../../lib/utils";
import { ThreadOpenProvider } from "./threadOpenContext";
import { usePaneDensity } from "./usePaneDensity";

export function GridThreadCell({
  node,
  grid,
  focused,
  availableThreads,
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
  const title = shell?.title ?? (draftSession === null ? "Untitled thread" : "New thread");
  const showDraft = draftId !== undefined && draftSession !== null;
  const threadCount = grid.tree === null ? 0 : preorderThreads(grid.tree).length;
  const { ref, density, width } = usePaneDensity(threadCount);
  const layout = paneDensityLayout(density, width);

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
        } as CSSProperties
      }
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background",
        focused ? "ring-1 ring-primary/40 ring-inset" : "ring-1 ring-border/60 ring-inset",
        density === "solo" && "[&_.chat-content-lane]:max-w-[45rem]",
        density === "compact" && "[&_[data-thread-find-text]]:line-clamp-5",
        density === "glance" &&
          "[&_[data-chat-composer-resting-row]]:hidden [&_[data-thread-find-text]]:line-clamp-3 [&_[data-changed-files-state=tree]]:hidden",
      )}
    >
      {layout.showHeader ? (
        <header className="group flex h-[30px] shrink-0 items-center gap-1.5 border-b border-border/60 bg-card/60 px-2">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status?.dotClass ?? "bg-muted-foreground/40",
              status?.pulse && "animate-status-pulse",
            )}
            aria-hidden
          />
          <span className="truncate text-xs font-medium text-foreground">{title}</span>
          {layout.showBranch && shell?.branch ? (
            <span className="truncate font-mono text-2xs text-muted-foreground">
              {shell.branch}
            </span>
          ) : null}
          {layout.showStatusLabel && status !== null ? (
            <span className="truncate text-2xs text-muted-foreground">{status.label}</span>
          ) : null}
          <span className="flex-1" />
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
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
            <Button
              variant="ghost-muted"
              size="icon-micro"
              aria-label="Archive thread"
              onClick={() => void archiveThread(threadRef, {})}
            >
              <ArchiveIcon />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-micro"
              aria-label="Close cell"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </div>
        </header>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
            size="icon-micro"
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
