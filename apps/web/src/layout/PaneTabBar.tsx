import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  LayoutTabAdd,
  LayoutTabBar,
  LayoutTabClose,
  LayoutTabIcon,
  LayoutTabMark,
  LayoutTabShell,
  LayoutTabSlot,
  LayoutTabStrip,
  LayoutTabTitle,
  LayoutTabTooltip,
  type LayoutBarPlacement,
  type LayoutTabMarkTone,
} from "../components/ui/layout-pane";
import { Tooltip, TooltipTrigger } from "../components/ui/tooltip";
import { observeResize } from "../lib/observeResize";
import { setWheelScroller, wheelDeltaPx } from "../motion/wheelGesture";
import { layoutChromeInsets } from "./layoutChrome";
import { closeLayoutTabByUser } from "./layoutActions";
import { isLayoutGhostTab, type LayoutTab } from "./layoutModel";
import { useLayoutPane } from "./layoutPaneContext";
import { useLayoutStore } from "./layoutStore";
import { beginLayoutTabDrag } from "./layoutTabDrag";

export interface LayoutTabLabel {
  icon?: ReactNode;
  title: string;
  /** Longer text for the hover label; the title when absent. */
  tooltip?: string;
  /** Work running, input needed or unsaved changes, drawn as a dot after the title. */
  mark?: LayoutTabMarkTone | undefined;
}

const MARK_LABEL: Record<LayoutTabMarkTone, string> = {
  running: "Running",
  attention: "Needs attention",
  dirty: "Unsaved changes",
};

/** A middle click closes a tab, as in browsers and editors. */
export function closeLayoutTabOnMiddleClick(
  event: { button: number; preventDefault: () => void },
  tabId: string,
): void {
  if (event.button !== 1) return;
  event.preventDefault();
  closeLayoutTabByUser(tabId);
}

/**
 * Keep overflow reachable by wheel and touch, and reveal the active tab without moving its pane.
 * `onOverflow` reports whether the tabs are wider than the strip.
 */
function useTabStripBehavior(
  activeTabId: string | null,
  onOverflow: (overflowing: boolean) => void,
) {
  const stripRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Own the tab scroller's wheel routing and reveal its active tab after the bar resizes.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tab = [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")].find(
      (candidate) => candidate.dataset.layoutPaneTab === activeTabId,
    );
    const reveal = () => {
      onOverflow(strip.scrollWidth > strip.clientWidth + 1);
      if (!tab) return;
      const bounds = strip.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      if (rect.left < bounds.left) strip.scrollLeft -= bounds.left - rect.left;
      else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right;
    };
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        strip.scrollWidth <= strip.clientWidth
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft += wheelDeltaPx(event.deltaY, event);
    };
    setWheelScroller(strip, () => strip.scrollWidth > strip.clientWidth);
    strip.addEventListener("wheel", wheel, { passive: false });
    const stop = observeResize(tab ? [strip, tab] : [strip], reveal);
    reveal();
    return () => {
      stop();
      setWheelScroller(strip, null);
      strip.removeEventListener("wheel", wheel);
    };
  });
  return stripRef;
}

/**
 * One tab of a pane. Click shows it, double-click keeps a ghost, middle click or its close
 * button closes it, right click asks for its menu without showing it, and dragging moves or
 * splits it.
 */
export const LayoutPaneTab = memo(function LayoutPaneTab({
  tab,
  label,
  active,
  first,
  onContextMenu,
}: {
  tab: LayoutTab;
  label: LayoutTabLabel;
  active: boolean;
  first: boolean;
  onContextMenu: ((tab: LayoutTab, position: { x: number; y: number }) => void) | undefined;
}) {
  return (
    <LayoutTabSlot>
      <Tooltip>
        <TooltipTrigger
          render={
            <LayoutTabShell
              active={active}
              ghost={isLayoutGhostTab(tab)}
              first={first}
              data-layout-pane-tab={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => useLayoutStore.getState().focusTab(tab.id)}
              onDoubleClick={() => useLayoutStore.getState().keepTab(tab.id)}
              onAuxClick={(event) => closeLayoutTabOnMiddleClick(event, tab.id)}
              onPointerDown={(event) => beginLayoutTabDrag(event, tab.id)}
              onMouseDown={(event) => {
                // Keep the browser's middle-click autoscroll from starting.
                if (event.button === 1) event.preventDefault();
              }}
              onContextMenu={(event) => {
                if (!onContextMenu) return;
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(tab, { x: event.clientX, y: event.clientY });
              }}
            />
          }
        >
          <LayoutTabIcon>{label.icon}</LayoutTabIcon>
          <LayoutTabTitle>{label.title}</LayoutTabTitle>
          {label.mark ? <LayoutTabMark tone={label.mark} label={MARK_LABEL[label.mark]} /> : null}
        </TooltipTrigger>
        <LayoutTabTooltip>{label.tooltip ?? label.title}</LayoutTabTooltip>
      </Tooltip>
      <LayoutTabClose
        tabId={tab.id}
        label={`Close ${label.title}`}
        onClick={() => closeLayoutTabByUser(tab.id)}
      />
    </LayoutTabSlot>
  );
});

/**
 * A pane's tabs and its `+` button. In a `window` placement the bar is the window chrome row
 * above the pane's surface, with `leading` and `trailing` for the window's own controls; in a
 * `pane` placement it is the pane's head.
 */
export function LayoutPaneTabBar({
  paneId,
  tabs,
  activeTabId,
  placement,
  tabLabel,
  onAdd,
  onTabContextMenu,
  leading,
  trailing,
  leadingInset,
  trailingInset,
}: {
  paneId: string;
  tabs: readonly LayoutTab[];
  activeTabId: string | null;
  placement: LayoutBarPlacement;
  tabLabel: (tab: LayoutTab) => LayoutTabLabel;
  /** Shows the `+` button and runs with the pane's id when it is pressed. */
  onAdd?: (paneId: string) => void;
  onTabContextMenu?: (tab: LayoutTab, position: { x: number; y: number }) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** CSS lengths clear of native window chrome; derived from the pane's edges when absent. */
  leadingInset?: string;
  trailingInset?: string;
}) {
  const { leadingEdge, trailingEdge } = useLayoutPane();
  const [overflowing, setOverflowing] = useState(false);
  const stripRef = useTabStripBehavior(activeTabId, setOverflowing);
  const chrome = placement === "window" ? layoutChromeInsets({ leadingEdge, trailingEdge }) : null;
  const leadingPad = leadingInset;
  const trailingPad = trailingInset ?? chrome?.trailing;
  return (
    <LayoutTabBar
      placement={placement}
      leadingInset={leadingPad}
      {...(leadingInset === undefined && chrome?.leadingClassName
        ? { className: chrome.leadingClassName }
        : {})}
      trailingInset={trailingPad}
      data-layout-bar-pane={paneId}
    >
      {leading}
      <LayoutTabStrip ref={stripRef} role="tablist" overflowing={overflowing}>
        {tabs.map((tab, index) => (
          <LayoutPaneTab
            key={tab.id}
            tab={tab}
            label={tabLabel(tab)}
            active={tab.id === activeTabId}
            first={index === 0}
            onContextMenu={onTabContextMenu}
          />
        ))}
      </LayoutTabStrip>
      {onAdd ? <LayoutTabAdd label="New tab" onClick={() => onAdd(paneId)} /> : null}
      {trailing}
    </LayoutTabBar>
  );
}
