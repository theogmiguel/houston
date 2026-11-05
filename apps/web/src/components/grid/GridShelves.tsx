import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { AnimatedHeight } from "../AnimatedHeight";
import { useThreadDropZone, type ThreadDragSource } from "../../grid/threadDrag";
import { cn } from "../../lib/utils";
import { MOTION_FEEDBACK_DEFAULT_EASE } from "../ui/motion-recipes";
import { SidebarShelfHeader } from "../sidebar/SidebarListMarkers";
import {
  SETTLED_SHELF_EXPANDED_KEY,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  SNOOZED_SHELF_EXPANDED_KEY,
} from "../sidebar/shelfState";

export type ShelfName = "snoozed" | "settled";

export interface GridShelvesProps {
  held: ReadonlyArray<EnvironmentThreadShell>;
  closed: ReadonlyArray<EnvironmentThreadShell>;
  renderCard: (thread: EnvironmentThreadShell, shelf: ShelfName) => ReactNode;
  closedDropTarget?: boolean;
  /** A thread is being dragged, so Closed reads as a place it can go. */
  closedDragActive?: boolean;
  onClosedDrop?: (source: ThreadDragSource) => void;
}

/**
 * The grid rail's shelves. Both cover every workspace and sit at the foot of
 * the rail, as the thread sidebar's shelves do.
 */
export function GridShelves({
  held,
  closed,
  renderCard,
  closedDropTarget = false,
  closedDragActive = false,
  onClosedDrop,
}: GridShelvesProps) {
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
  const visibleClosed = closed.slice(0, settledVisibleCount);
  const hiddenClosedCount = Math.max(0, closed.length - visibleClosed.length);

  return (
    <div className="flex flex-col gap-px" data-testid="grid-shelves">
      <AnimatedHeight>
        {snoozedExpanded ? (
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
      <SidebarShelfHeader
        variant="rail"
        shelf="snoozed"
        label="On hold"
        count={held.length}
        toggle={{
          expanded: snoozedExpanded,
          onToggle: () => setSnoozedExpanded((value) => !value),
        }}
      />
      <div
        ref={closedRef}
        className={cn(
          "flex flex-col gap-px rounded-(--r-ctl)",
          closedDropTarget && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
        )}
      >
        <AnimatedHeight>
          {settledExpanded ? (
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
                  onClick={() => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT)}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-(--r-ctl) pr-2 pl-7.5 text-left text-xs text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    MOTION_FEEDBACK_DEFAULT_EASE,
                  )}
                >
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                  Show {Math.min(hiddenClosedCount, SETTLED_TAIL_PAGE_COUNT)} more
                </button>
              ) : null}
            </div>
          ) : null}
        </AnimatedHeight>
        <SidebarShelfHeader
          variant="rail"
          shelf="settled"
          label="Closed"
          count={closed.length}
          dragging={closedDragActive}
          isDropTarget={closedDropTarget}
          toggle={{
            expanded: settledExpanded,
            onToggle: () => setSettledExpanded((value) => !value),
          }}
        />
      </div>
    </div>
  );
}
