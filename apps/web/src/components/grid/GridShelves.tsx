import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronDownIcon } from "lucide-react";
import { useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
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
  onClosedDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onClosedDragLeave?: () => void;
  onClosedDrop?: (event: ReactDragEvent<HTMLElement>) => void;
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
  onClosedDragOver,
  onClosedDragLeave,
  onClosedDrop,
}: GridShelvesProps) {
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
      <div>
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
      </div>
      {snoozedExpanded
        ? held.map((thread) => <div key={thread.id}>{renderCard(thread, "snoozed")}</div>)
        : null}
      <div
        className={cn(
          "rounded-(--r-ctl)",
          closedDropTarget && "bg-(--accent-muted) ring-1 ring-(--accent-ink) ring-inset",
        )}
        onDragOver={onClosedDragOver}
        onDragLeave={onClosedDragLeave}
        onDrop={onClosedDrop}
      >
        <SidebarShelfHeader
          variant="rail"
          shelf="settled"
          label="Closed"
          count={closed.length}
          dragging={onClosedDragOver !== undefined}
          isDropTarget={closedDropTarget}
          toggle={{
            expanded: settledExpanded,
            onToggle: () => setSettledExpanded((value) => !value),
          }}
        />
      </div>
      {settledExpanded
        ? visibleClosed.map((thread) => <div key={thread.id}>{renderCard(thread, "settled")}</div>)
        : null}
      {settledExpanded && hiddenClosedCount > 0 ? (
        <button
          type="button"
          onClick={() => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT)}
          className="flex h-7 items-center gap-2 rounded-(--r-ctl) pl-7.5 pr-2 text-left text-xs text-secondary-label hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          Show {Math.min(hiddenClosedCount, SETTLED_TAIL_PAGE_COUNT)} more
        </button>
      ) : null}
    </div>
  );
}
