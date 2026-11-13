import { AppWindowIcon, Columns2Icon, Layers2Icon, Rows2Icon } from "lucide-react";
import { createPortal } from "react-dom";

import {
  LayoutDragGhost,
  LayoutDragOverlay,
  LayoutDropExtendBar,
  LayoutDropGrip,
  LayoutDropInsertMark,
  LayoutDropPill,
  LayoutDropZoneBox,
  LayoutPassiveLayer,
} from "../components/ui/layout-pane";
import {
  LAYOUT_DROP_CHROME_HEIGHT,
  layoutDropLabel,
  useLayoutDragState,
  type LayoutDragPane,
  type LayoutDragRect,
  type LayoutDragState,
  type LayoutDropTarget,
} from "./layoutDrag";
import { findLayoutTab, type LayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import type { LayoutTabLabel } from "./PaneTabBar";

/** Drop zones sit 8px inside the pane, 7.5px each side of its middle. */
const ZONE_INSET = 8;
/** Edge grips are 40x4, just inside each side of a pane. */
const GRIP_LENGTH = 40;
const GRIP_THICKNESS = 4;
/** Window-edge bars are 6px, 4px outside the strip. */
const EXTEND_THICKNESS = 6;
const EXTEND_GAP = 4;

type Box = { left: number; top: number; width: number; height: number };

function box(rect: LayoutDragRect): Box {
  return {
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.right - rect.left),
    height: Math.max(0, rect.bottom - rect.top),
  };
}

/** The part of the window a drop fills, previewed as the highlighted zone. */
export function dropTargetZone(state: LayoutDragState, target: LayoutDropTarget): Box | null {
  const { strip } = state;
  if (target.kind === "extend") {
    const width = strip.right - strip.left;
    const height = strip.bottom - strip.top;
    if (target.edge === "left") return box({ ...strip, right: strip.left + width / 3 });
    if (target.edge === "right") return box({ ...strip, left: strip.right - width / 3 });
    return box({ ...strip, top: strip.bottom - height / 3 });
  }
  const pane = state.panes.find((candidate) => candidate.paneId === target.paneId);
  if (!pane) return null;
  const { rect } = pane;
  if (target.kind === "into") {
    return box({
      left: rect.left + ZONE_INSET / 2,
      top: rect.top + ZONE_INSET / 2,
      right: rect.right - ZONE_INSET / 2,
      bottom: rect.top + LAYOUT_DROP_CHROME_HEIGHT - ZONE_INSET / 2,
    });
  }
  const body = {
    left: rect.left + ZONE_INSET,
    top: rect.top + LAYOUT_DROP_CHROME_HEIGHT,
    right: rect.right - ZONE_INSET,
    bottom: rect.bottom - ZONE_INSET,
  };
  const midX = (rect.left + rect.right) / 2;
  const midY = (body.top + body.bottom) / 2;
  const half = ZONE_INSET - 0.5;
  switch (target.side) {
    case "left":
      return box({ ...body, right: midX - half });
    case "right":
      return box({ ...body, left: midX + half });
    case "up":
      return box({ ...body, bottom: midY - half });
    case "down":
      return box({ ...body, top: midY + half });
  }
}

/** Where a tab dropped on a tab bar lands: the gap before the tab at the target's index. */
export function dropInsertMark(
  state: LayoutDragState,
  target: LayoutDropTarget,
): { left: number; top: number; height: number } | null {
  if (target.kind !== "into" || target.index === undefined) return null;
  const pane = state.panes.find((candidate) => candidate.paneId === target.paneId);
  const draggedTabId = state.source.kind === "tab" ? state.source.tabId : null;
  const tabs = pane?.tabs?.filter((tab) => tab.id !== draggedTabId) ?? [];
  const last = tabs.at(-1);
  if (last === undefined) return null;
  const next = tabs[target.index];
  return {
    left: next === undefined ? last.rect.right : next.rect.left,
    top: last.rect.top,
    height: last.rect.bottom - last.rect.top,
  };
}

function PillIcon({ target }: { target: LayoutDropTarget }) {
  const className = "size-3.25 shrink-0";
  if (target.kind === "into") return <AppWindowIcon aria-hidden className={className} />;
  if (target.kind === "extend" && target.edge === "bottom") {
    return <Layers2Icon aria-hidden className={className} />;
  }
  if (target.kind === "side" && (target.side === "up" || target.side === "down")) {
    return <Rows2Icon aria-hidden className={className} />;
  }
  return <Columns2Icon aria-hidden className={className} />;
}

function PaneGrips({ pane, target }: { pane: LayoutDragPane; target: LayoutDropTarget | null }) {
  const { rect } = pane;
  const active = target?.kind === "side" && target.paneId === pane.paneId ? target.side : null;
  const bodyTop = rect.top + LAYOUT_DROP_CHROME_HEIGHT;
  const midX = (rect.left + rect.right) / 2;
  const midY = (bodyTop + rect.bottom) / 2;
  const grips = [
    {
      side: "up",
      left: midX - GRIP_LENGTH / 2,
      top: bodyTop - GRIP_THICKNESS / 2,
      width: GRIP_LENGTH,
      height: GRIP_THICKNESS,
    },
    {
      side: "down",
      left: midX - GRIP_LENGTH / 2,
      top: rect.bottom - ZONE_INSET - GRIP_THICKNESS / 2,
      width: GRIP_LENGTH,
      height: GRIP_THICKNESS,
    },
    {
      side: "left",
      left: rect.left + ZONE_INSET - GRIP_THICKNESS / 2,
      top: midY - GRIP_LENGTH / 2,
      width: GRIP_THICKNESS,
      height: GRIP_LENGTH,
    },
    {
      side: "right",
      left: rect.right - ZONE_INSET - GRIP_THICKNESS / 2,
      top: midY - GRIP_LENGTH / 2,
      width: GRIP_THICKNESS,
      height: GRIP_LENGTH,
    },
  ] as const;
  return grips.map((grip) => (
    <LayoutDropGrip
      key={grip.side}
      side={grip.side}
      active={grip.side === active}
      style={{ left: grip.left, top: grip.top, width: grip.width, height: grip.height }}
    />
  ));
}

function ExtendBars({ state }: { state: LayoutDragState }) {
  const { strip, target } = state;
  const active = target?.kind === "extend" ? target.edge : null;
  const maxX = window.innerWidth - EXTEND_THICKNESS;
  const maxY = window.innerHeight - EXTEND_THICKNESS;
  const bars = [
    {
      edge: "left",
      left: Math.max(0, strip.left - EXTEND_GAP - EXTEND_THICKNESS),
      top: strip.top + ZONE_INSET,
      width: EXTEND_THICKNESS,
      height: strip.bottom - strip.top - ZONE_INSET * 2,
    },
    {
      edge: "right",
      left: Math.min(maxX, strip.right + EXTEND_GAP),
      top: strip.top + ZONE_INSET,
      width: EXTEND_THICKNESS,
      height: strip.bottom - strip.top - ZONE_INSET * 2,
    },
    {
      edge: "bottom",
      left: strip.left + ZONE_INSET,
      top: Math.min(maxY, strip.bottom + EXTEND_GAP - 1),
      width: strip.right - strip.left - ZONE_INSET * 2,
      height: EXTEND_THICKNESS,
    },
  ] as const;
  return bars.map((bar) => (
    <LayoutDropExtendBar
      key={bar.edge}
      edge={bar.edge}
      active={bar.edge === active}
      style={{ left: bar.left, top: bar.top, width: bar.width, height: bar.height }}
    />
  ));
}

function DraggedTab({
  tab,
  point,
  tabLabel,
}: {
  tab: LayoutTab;
  point: { x: number; y: number };
  tabLabel: (tab: LayoutTab) => LayoutTabLabel;
}) {
  const label = tabLabel(tab);
  return (
    <LayoutDragGhost
      style={{ transform: `translate(${point.x - 24}px, ${point.y - 14}px) rotate(-2deg)` }}
    >
      {label.icon}
      <span className="min-w-0 truncate">{label.title}</span>
    </LayoutDragGhost>
  );
}

/**
 * The overlay of a layout drag: grips on every pane side, the highlighted zone, a pill naming
 * where the drop lands and the dragged tab under the pointer. A window overlay keeps webviews
 * and iframes from swallowing the drag.
 */
export function LayoutDropZones({ tabLabel }: { tabLabel: (tab: LayoutTab) => LayoutTabLabel }) {
  const state = useLayoutDragState();
  const draggedTabId = state?.source.kind === "tab" ? state.source.tabId : null;
  const dragged = useLayoutStore((store) =>
    draggedTabId === null
      ? null
      : (findLayoutTab(store.layout, (tab) => tab.id === draggedTabId)?.tab ?? null),
  );
  if (!state) return null;
  const zone = state.target ? dropTargetZone(state, state.target) : null;
  const insert = state.target ? dropInsertMark(state, state.target) : null;
  return createPortal(
    <LayoutDragOverlay>
      <LayoutPassiveLayer>
        <ExtendBars state={state} />
        {zone ? <LayoutDropZoneBox style={zone} /> : null}
        {insert ? <LayoutDropInsertMark style={insert} /> : null}
        {state.panes.map((pane) => (
          <PaneGrips key={pane.paneId} pane={pane} target={state.target} />
        ))}
        {dragged ? <DraggedTab tab={dragged} point={state.point} tabLabel={tabLabel} /> : null}
        {zone && state.target ? (
          <LayoutDropPill
            style={{ left: zone.left + zone.width / 2, top: zone.top + zone.height / 2 }}
          >
            <PillIcon target={state.target} />
            {layoutDropLabel(state.target)}
          </LayoutDropPill>
        ) : null}
      </LayoutPassiveLayer>
    </LayoutDragOverlay>,
    document.body,
  );
}
