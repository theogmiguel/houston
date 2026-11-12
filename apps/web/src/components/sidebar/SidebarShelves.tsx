import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import type { OlderSettledScope } from "@houston-app/client-runtime/state/threads";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { AnimatedHeight } from "../AnimatedHeight";
import { useThreadDropZone, type ThreadDragSource } from "../../threads/threadDrag";
import { cn } from "../../lib/utils";
import { Separator } from "../ui/separator";
import { MOTION_FEEDBACK_DEFAULT_EASE } from "../ui/motion-recipes";
import { SidebarShelfHeader } from "./SidebarListMarkers";
import {
  SETTLED_SHELF_EXPANDED_KEY,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  SNOOZED_SHELF_EXPANDED_KEY,
} from "./shelfState";

const NO_SCOPES: ReadonlyArray<OlderSettledScope> = [];
const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

export type ShelfName = "snoozed" | "settled";

export interface SidebarShelvesProps {
  held: ReadonlyArray<EnvironmentThreadShell>;
  closed: ReadonlyArray<EnvironmentThreadShell>;
  renderCard: (thread: EnvironmentThreadShell, shelf: ShelfName) => ReactNode;
  closedDropTarget?: boolean;
  /** A thread is being dragged, so Closed reads as a place it can go. */
  closedDragActive?: boolean;
  onClosedDrop?: (source: ThreadDragSource) => void;
  /** Both shelves show every row they hold, such as while a search lists its matches. */
  forceExpanded?: boolean;
  /**
   * Where older Closed threads load from, and every thread the client holds in those scopes. Shells
   * leave older closed threads out, so the shelf reads them from the server as it is paged.
   */
  older?: {
    readonly scopes: ReadonlyArray<OlderSettledScope>;
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  };
}

/**
 * The grid rail's shelves. Both cover every workspace and sit at the foot of
 * the rail, as the thread sidebar's shelves do.
 */
export function SidebarShelves({
  held,
  closed,
  renderCard,
  closedDropTarget = false,
  closedDragActive = false,
  onClosedDrop,
  forceExpanded = false,
  older,
}: SidebarShelvesProps) {
  const closedRef = useRef<HTMLDivElement | null>(null);
  useThreadDropZone(
    closedRef,
    () => ({ kind: "closed" }),
    (source) => onClosedDrop?.(source),
  );
  const [snoozedExpanded, setSnoozedExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [settledExpanded, setSettledExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const snoozedOpen = forceExpanded || snoozedExpanded;
  const settledOpen = forceExpanded || settledExpanded;
  const olderShelf = useOlderSettledShelf({
    scopes: older?.scopes ?? NO_SCOPES,
    expanded: settledExpanded,
    visibleCount: settledVisibleCount,
  });
  const listedClosed = closed.filter(olderShelf.isListed);
  useOlderSettledShelfGrowth(olderShelf, listedClosed);
  const closedCount = closed.length + olderShelf.unloadedCount(older?.threads ?? NO_THREADS);
  const visibleClosed = forceExpanded ? listedClosed : listedClosed.slice(0, settledVisibleCount);
  const hiddenClosedCount = forceExpanded ? 0 : Math.max(0, closedCount - visibleClosed.length);
  // An empty shelf is noise at the foot of the rail. Closed counts the older threads the server
  // still holds, and stays while a thread is dragged because its row is the drop target.
  const showHeld = held.length > 0;
  const showClosed = closedCount > 0 || closedDragActive || closedDropTarget;
  if (!showHeld && !showClosed) return null;

  return (
    <div className="flex flex-col gap-px" data-testid="grid-shelves">
      <Separator className="mb-1" data-shelves-rule="" />
      <AnimatedHeight>
        {showHeld && snoozedOpen ? (
          <div
            className="flex max-h-56 flex-col gap-px overflow-y-auto pb-1"
            data-testid="grid-snoozed-shelf-list"
          >
            {held.map((thread) => (
              <div key={thread.id}>{renderCard(thread, "snoozed")}</div>
            ))}
          </div>
        ) : null}
      </AnimatedHeight>
      {showHeld ? (
        <SidebarShelfHeader
          variant="rail"
          shelf="snoozed"
          label="On hold"
          count={held.length}
          toggle={{
            expanded: snoozedOpen,
            onToggle: () => setSnoozedExpanded((value) => !value),
          }}
        />
      ) : null}
      <div
        ref={closedRef}
        className={cn(
          "flex flex-col gap-px rounded-(--r-ctl)",
          closedDropTarget && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
        )}
      >
        <AnimatedHeight>
          {settledOpen ? (
            <div
              className="flex max-h-56 flex-col gap-px overflow-y-auto pb-1"
              data-testid="grid-settled-shelf-list"
            >
              {visibleClosed.map((thread) => (
                <div key={thread.id}>{renderCard(thread, "settled")}</div>
              ))}
              {hiddenClosedCount > 0 ? (
                <button
                  type="button"
                  disabled={olderShelf.loading}
                  onClick={() => {
                    olderShelf.retry();
                    setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT);
                  }}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-(--r-ctl) pr-2 pl-7.5 text-left text-xs text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    MOTION_FEEDBACK_DEFAULT_EASE,
                  )}
                >
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                  {olderShelf.loading
                    ? "Loading"
                    : olderShelf.failed
                      ? "Could not load older threads. Retry"
                      : `Show ${Math.min(hiddenClosedCount, SETTLED_TAIL_PAGE_COUNT)} more`}
                </button>
              ) : null}
            </div>
          ) : null}
        </AnimatedHeight>
        {showClosed ? (
          <SidebarShelfHeader
            variant="rail"
            shelf="settled"
            label="Closed"
            count={closedCount}
            dragging={closedDragActive}
            isDropTarget={closedDropTarget}
            toggle={{
              expanded: settledOpen,
              onToggle: () => setSettledExpanded((value) => !value),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
