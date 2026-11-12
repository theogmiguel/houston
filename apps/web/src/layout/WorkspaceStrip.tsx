import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  LayoutEmptyWorkspaceFrame,
  LayoutHeldWidth,
  LayoutPaneBody,
  LayoutPaneFrame,
  LayoutPeekDot,
  LayoutStage,
  LayoutStripScroller,
} from "../components/ui/layout-pane";
import { LayoutOverviewBackdrop } from "../components/ui/layout-overlay";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useStableCallback } from "../hooks/useStableCallback";
import { observeResize } from "../lib/observeResize";
import { isMacPlatform } from "../lib/utils";
import {
  endUserStripScroll,
  moveStripCamera,
  noteUserStripScroll,
  settleStripCamera,
  userStripScrollAge,
} from "../motion/stripCamera";
import { sidewaysWheelScrollsStrip, wheelDeltaPx } from "../motion/wheelGesture";
import {
  applyWorkspaceStackTransform,
  attachWorkspaceSwitch,
  finishWorkspaceSwitch,
  rememberWorkspaceCamera,
  useWorkspaceStack,
  workspaceCamera,
  workspaceStackCamera,
  type WorkspaceStack,
} from "../motion/workspaceSwitch";
import { LayoutResizeHandles } from "./ColumnResizeHandle";
import {
  keptTabIds,
  nearTabIdsInOverview,
  nearTabIdsOnStrip,
  nextRecentTabIds,
  nextRetainedTabIds,
} from "./chatRetention";
import { LayoutEmptyPane, LayoutLauncherShell } from "./EmptyPane";
import { useLayoutBehavior } from "./layoutBehavior";
import {
  selectFocusedPane,
  selectFocusedWorkspace,
  selectWindowStartPaneId,
  type LayoutPane,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutTab,
  type LayoutViewport,
  type LayoutWorkspace,
} from "./layoutModel";
import { LayoutPaneContext, type LayoutPaneState } from "./layoutPaneContext";
import { setLayoutStripViewportWidth, useLayoutStore } from "./layoutStore";
import { getOverviewEntry, getOverviewPhase, useOverviewPhase } from "./overviewPhase";
import { onOverviewBackgroundPointerDown, OverviewStageOverlay } from "./OverviewStageOverlay";
import {
  overviewSlotStyle,
  selectOverviewStage,
  selectOverviewStartPaneIds,
} from "./overviewStage";
import { overviewZoomTransition } from "./overviewZoom";
import { useOverviewStage } from "./useOverviewStage";
import {
  FULL_RECT,
  HALF_PANE_GAP,
  selectShownSlots,
  slotStyle,
  stackSlotStyle,
  type StackRow,
} from "./paneGeometry";
import { LayoutPaneTabBar, type LayoutTabLabel } from "./PaneTabBar";
import { paneToFollow, tabIdsOnScreen } from "./stripView";

/** Gutter between rows while a workspace switch moves them: where the window chrome shows. */
const SWITCH_ROW_GAP_PX = 8;
/**
 * A split pane narrower than this opens its right panel as a sheet, as a window under the
 * base's 980px breakpoint does.
 */
const INLINE_PANEL_MIN_PX = 981;
/** A strip scroll counts as the user's for this long after their wheel, swipe or drag stops. */
const USER_SCROLL_END_MS = 250;
/** The panes on screen are reported once the strip's scroll has been quiet this long. */
const ON_SCREEN_SCROLL_SETTLE_MS = 120;
/**
 * A settled scroll is the user's when their gesture moved the strip this recently; a fling keeps
 * scrolling a while after the touch ends.
 */
const USER_SCROLL_SETTLE_WINDOW_MS = 2000;
const NO_TABS: ReadonlySet<string> = new Set();

/** What a pane tells the content `renderTab` draws for its active tab. */
export type LayoutTabRenderContext = LayoutPaneState;

export interface LayoutWorkspaceStripProps {
  /** The layout to draw: the store's, or a preview of it. */
  layout: LayoutState;
  /** The content of a tab; the strip never looks inside it. */
  renderTab: (tab: LayoutTab, context: LayoutTabRenderContext) => ReactNode;
  tabLabel: (tab: LayoutTab) => LayoutTabLabel;
  /** Shows a `+` on each tab bar and runs with the pane that asked. */
  onAddTab?: (paneId: string) => void;
  onTabContextMenu?: (tab: LayoutTab, position: { x: number; y: number }) => void;
  /** What an empty workspace holds: the launcher. */
  empty?: ReactNode;
  /** False while the layout sits beneath a page: the strip hides and takes no input. */
  active?: boolean;
  /** One pane fills the window; defaults to the `max-md` breakpoint. */
  narrow?: boolean;
  /** Placed before the tabs of the top pane at the window's leading edge. */
  windowBarLeading?: ReactNode;
  /** Placed after the tabs of the top pane at the window's trailing edge. */
  windowBarTrailing?: ReactNode;
  /**
   * The active tabs at least half on screen, reported once the strip's scroll settles and when
   * the strip is hidden (empty). The strip also moves focus to the column most in view after a
   * scroll of the user's.
   */
  onScreenTabsChange?: (tabIds: ReadonlySet<string>) => void;
  /**
   * Tabs whose content is expensive to rebuild (a chat): once shown, their body stays mounted,
   * hidden, when the tab stops being shown, until it closes. Each also learns from its pane's
   * state (`near`, `kept`) when to draw its content.
   */
  retainTab?: (tab: LayoutTab) => boolean;
}

const FULL_STYLE = { left: 0, top: 0, width: "100%", height: "100%" } as const;

interface Placed {
  workspace: LayoutWorkspace;
  pane: LayoutPane;
  slot: LayoutPaneSlot;
  style: React.CSSProperties;
  /** Pixel width of the strip the slot's rect is a share of. */
  stripPx: number;
}

function selectStackRows(
  stack: WorkspaceStack,
  layout: LayoutState,
  viewport: LayoutViewport,
  narrow: boolean,
  maximizedTabId: string | null,
): StackRow[] {
  return stack.rows.map(({ id, offset }) => {
    // A row's workspace can be gone (an empty one left behind): it shows as empty.
    const workspace = layout.workspaces.find((candidate) => candidate.id === id) ?? null;
    if (!workspace || workspace.columns.length === 0) {
      return { id, workspace, offset, slots: [], stripWidth: 1, camera: 0 };
    }
    const shown = selectShownSlots(workspace, viewport, narrow, maximizedTabId);
    const stripPx = shown.stripWidth * viewport.width;
    return {
      id,
      workspace,
      offset,
      slots: shown.slots,
      stripWidth: shown.stripWidth,
      camera: workspaceStackCamera(workspace, shown.slots, stripPx, viewport.width),
    };
  });
}

/** The strip's visible width in px, kept current as the window or sidebar resizes. */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- observes the strip DOM width so pane geometry follows window and sidebar resizes
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    return observeResize(element, () => setWidth(element.clientWidth));
  }, [ref]);
  return width;
}

interface StripSpan {
  left: number;
  width: number;
}

/**
 * Preserve screen positions when the strip's edge shifts, except at its start, and reveal the
 * focused pane after a resize without exposing trailing chrome.
 */
function useStripResizeScroll(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  focusedSpanRef: React.RefObject<StripSpan | null>,
  active: boolean,
): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Observe strip resizes and preserve its DOM scroll position before paint.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !active) return;
    let scrollLeft = scroller.scrollLeft;
    let width = scroller.clientWidth;
    let left = scroller.getBoundingClientRect().left;
    const onScroll = () => {
      // The clamp of a resize the observer has not seen yet: it starts from before it.
      if (scroller.clientWidth !== width) return;
      scrollLeft = scroller.scrollLeft;
    };
    const stopObserving = observeResize(scroller, () => {
      if (scroller.clientWidth === width) return;
      const grew = scroller.clientWidth > width;
      width = scroller.clientWidth;
      const nextLeft = scroller.getBoundingClientRect().left;
      const shift = nextLeft - left;
      left = nextLeft;
      const clamped = grew && scroller.scrollLeft + width >= scroller.scrollWidth - 1;
      const from = clamped ? scrollLeft : scroller.scrollLeft;
      let target =
        Math.abs(shift) < 0.5 ? scroller.scrollLeft : from > 0 ? Math.max(0, from + shift) : 0;
      const focused = focusedSpanRef.current;
      if (focused && focused.left < target - 1) target = focused.left;
      else if (focused && focused.left + focused.width > target + width + 1) {
        target = Math.min(focused.left, focused.left + focused.width - width);
      }
      scrollLeft = target;
      if (Math.abs(target - scroller.scrollLeft) < 0.5) return;
      settleStripCamera();
      scroller.scrollLeft = target;
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopObserving();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [active, focusedSpanRef, scrollerRef]);
}

/**
 * Sideways wheel, the held-chord wheel and a middle-button drag move the strip, and any scroll
 * of the user's takes the camera over from a spring in flight.
 */
function useStripScrollGestures(scrollerRef: React.RefObject<HTMLDivElement | null>): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Own wheel, middle-drag and touch subscriptions on the mounted strip scroller.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const mac = isMacPlatform(navigator.platform);
    const held = (event: MouseEvent) =>
      mac ? event.metaKey && event.altKey : event.ctrlKey && event.altKey;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const noteUserScroll = () => {
      noteUserStripScroll();
      if (endTimer !== null) clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        endTimer = null;
        if (userStripScrollAge() >= USER_SCROLL_END_MS) endUserStripScroll();
      }, USER_SCROLL_END_MS);
    };
    const moveStrip = (event: WheelEvent) => {
      event.preventDefault();
      settleStripCamera();
      noteUserScroll();
      scroller.scrollLeft += wheelDeltaPx(event.deltaX, event);
    };
    const onHeldWheel = (event: WheelEvent) => {
      if (held(event) && Math.abs(event.deltaX) > Math.abs(event.deltaY)) moveStrip(event);
    };
    const onSidewaysWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return;
      if (sidewaysWheelScrollsStrip(event.composedPath(), scroller, event.deltaX, event.deltaY)) {
        moveStrip(event);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 1 || !held(event)) return;
      event.preventDefault();
      settleStripCamera();
      const startX = event.clientX;
      const startLeft = scroller.scrollLeft;
      const move = (moveEvent: PointerEvent) => {
        noteUserScroll();
        scroller.scrollLeft = startLeft - (moveEvent.clientX - startX);
      };
      const end = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    };
    // A finger drags the scroll itself, so it lands the camera where it shows.
    const onTouchMove = () => {
      settleStripCamera();
      noteUserScroll();
    };
    scroller.addEventListener("wheel", onHeldWheel, { passive: false, capture: true });
    scroller.addEventListener("wheel", onSidewaysWheel, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown, true);
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      if (endTimer !== null) clearTimeout(endTimer);
      scroller.removeEventListener("wheel", onHeldWheel, true);
      scroller.removeEventListener("wheel", onSidewaysWheel);
      scroller.removeEventListener("pointerdown", onPointerDown, true);
      scroller.removeEventListener("touchmove", onTouchMove);
    };
  }, [scrollerRef]);
}

/**
 * The workspace strip: the focused workspace's columns in a row that scrolls sideways, each
 * column a stack of panes, each pane a tab bar over its active tab's content. Tab content comes
 * from `renderTab`, so the strip imports no chat, terminal or route code. While a workspace
 * switch is in motion the workspaces stack vertically and the camera moves on the compositor.
 */
export function LayoutWorkspaceStrip({
  layout,
  renderTab,
  tabLabel,
  onAddTab,
  onTabContextMenu,
  empty,
  active = true,
  narrow: narrowProp,
  windowBarLeading,
  windowBarTrailing,
  onScreenTabsChange,
  retainTab,
}: LayoutWorkspaceStripProps) {
  const mediaNarrow = useMediaQuery("max-md");
  const narrow = narrowProp ?? mediaNarrow;
  // A resize drag previews here and commits to the store once on release.
  const [preview, setPreview] = useState<{ layout: LayoutState; heldStripPx: number } | null>(null);
  const shown = preview?.layout ?? layout;
  const workspace = selectFocusedWorkspace(shown);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportWidth = useElementWidth(scrollerRef);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Publish the measured desktop strip width for imperative pane placement.
  useEffect(() => {
    // Below md one pane fills the window; columns stay arranged for the last wide one. The first
    // render's guess (the window's width) is not reported.
    if (narrow || scrollerRef.current?.clientWidth !== viewportWidth) return;
    setLayoutStripViewportWidth(viewportWidth);
  }, [narrow, viewportWidth]);
  const maximizedTabId = useLayoutStore((state) => state.maximizedTabId);
  const unseenTabIds = useLayoutStore((state) => state.unseenTabIds);
  const centerRequest = useLayoutStore((state) => state.centerRequest);
  const { whenNoRoom } = useLayoutBehavior();
  const workspaceStack = useWorkspaceStack();
  // The overview lays every workspace out on one stage, so the panes it shows are the live ones,
  // zoomed out. A workspace switch it interrupts hands its stack over.
  const overviewPhase = useOverviewPhase();
  const staged = overviewPhase !== "closed";
  const stacked = !staged && workspaceStack !== null;
  const viewport: LayoutViewport = { width: viewportWidth, whenNoRoom };
  const stage = selectOverviewStage(shown, viewport, window.innerWidth);
  const overviewStarts = staged
    ? selectOverviewStartPaneIds(stage, viewportWidth, getOverviewEntry())
    : null;
  const own = selectShownSlots(workspace, viewport, narrow, maximizedTabId);
  const stripPx = own.stripWidth * viewportWidth;
  const stackRows =
    workspaceStack && !staged
      ? selectStackRows(workspaceStack, shown, viewport, narrow, maximizedTabId)
      : [];
  const dragging = preview !== null;
  const split = own.paneCount > 1;

  const paneOf = (candidate: LayoutWorkspace, paneId: string): LayoutPane | null => {
    for (const column of candidate.columns) {
      const pane = column.panes.find((entry) => entry.id === paneId);
      if (pane) return pane;
    }
    return null;
  };
  const placed: Placed[] = [];
  const emptyRows: { id: string; style: React.CSSProperties; own: boolean }[] = [];
  if (staged) {
    for (const row of stage.rows) {
      if (row.workspace.columns.length === 0) {
        emptyRows.push({
          id: row.workspace.id,
          style: overviewSlotStyle(row, fullSlot(), stage.gap, HALF_PANE_GAP),
          own: false,
        });
        continue;
      }
      for (const slot of row.slots) {
        const pane = paneOf(row.workspace, slot.paneId);
        if (pane) {
          placed.push({
            workspace: row.workspace,
            pane,
            slot,
            style: overviewSlotStyle(row, slot, stage.gap, HALF_PANE_GAP),
            stripPx: row.stripWidth * viewportWidth,
          });
        }
      }
    }
  } else if (workspaceStack) {
    for (const row of stackRows) {
      if (!row.workspace || row.slots.length === 0) {
        emptyRows.push({
          id: row.id,
          style: stackSlotStyle(row, { ...fullSlot(), rect: { ...FULL_RECT } }, workspaceStack.gap),
          own: false,
        });
        continue;
      }
      for (const slot of row.slots) {
        const pane = paneOf(row.workspace, slot.paneId);
        if (pane) {
          placed.push({
            workspace: row.workspace,
            pane,
            slot,
            style: stackSlotStyle(row, slot, workspaceStack.gap),
            stripPx: row.stripWidth * viewportWidth,
          });
        }
      }
    }
  } else if (workspace.columns.length === 0) {
    emptyRows.push({ id: workspace.id, style: FULL_STYLE, own: true });
  } else {
    for (const slot of own.slots) {
      const pane = paneOf(workspace, slot.paneId);
      if (pane) placed.push({ workspace, pane, slot, style: slotStyle(slot), stripPx });
    }
  }

  const focusedPane = selectFocusedPane(shown);
  const focusedPaneId = focusedPane?.id ?? null;
  const focusedSlot = own.slots.find((slot) => slot.paneId === focusedPaneId) ?? null;
  const focusedLeft = focusedSlot ? Math.round(focusedSlot.rect.left * stripPx) : null;
  const focusedWidth = focusedSlot ? Math.round(focusedSlot.rect.width * stripPx) : null;

  // The panes that touch the window's top corners, where native window controls sit. Derived
  // from the scroll position at coarse steps, not per frame.
  const [edges, setEdges] = useState<{ leading: string | null; trailing: string | null }>({
    leading: null,
    trailing: null,
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Derive window-edge panes from the committed scroll position and publish them only when they change.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const compute = () => {
      const left = scroller.scrollLeft;
      const width = scroller.clientWidth;
      const leading = selectWindowStartPaneId(own.slots, left, stripPx);
      const trailing =
        own.slots.find(
          (slot) =>
            !slot.hasAbove &&
            Math.abs((slot.rect.left + slot.rect.width) * stripPx - (left + width)) < 1,
        )?.paneId ?? null;
      setEdges((current) =>
        current.leading === leading && current.trailing === trailing
          ? current
          : { leading, trailing },
      );
    };
    compute();
    scroller.addEventListener("scroll", compute, { passive: true });
    return () => scroller.removeEventListener("scroll", compute);
  });

  const stagedFlagsRef = useRef({ shown: true, blocked: false });
  const stripShown = !staged && !stacked && !narrow && maximizedTabId === null && !dragging;
  const focusedSpanRef = useRef<StripSpan | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Publish committed geometry for native gesture callbacks.
  useLayoutEffect(() => {
    stagedFlagsRef.current = { shown: stripShown, blocked: false };
    focusedSpanRef.current =
      focusedLeft === null || focusedWidth === null
        ? null
        : { left: focusedLeft, width: focusedWidth };
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Attach workspace gestures to the mounted strip DOM and release them on cleanup.
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollerRef.current;
    const stage = stageRef.current;
    if (!active || !root || !scroller || !stage) return;
    return attachWorkspaceSwitch({
      root,
      scroller,
      stage,
      gap: () => SWITCH_ROW_GAP_PX,
      blocked: () => useLayoutStore.getState().overviewOpen || getOverviewPhase() !== "closed",
      stripShown: () => stagedFlagsRef.current.shown,
    });
  }, [active]);

  // The switch's stack and the strip trade places: entering, the stage spans one window and each
  // row carries its own scroll; leaving, the strip scrolls to where its row was drawn.
  const wasStacked = useRef(false);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Transfer DOM scroll and transforms when entering or leaving the workspace stack.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const stage = stageRef.current;
    if (!scroller || !stage) return;
    if (stacked) {
      for (const row of stackRows) rememberWorkspaceCamera(row.id, row.camera);
      if (!wasStacked.current) scroller.scrollLeft = 0;
      wasStacked.current = true;
      applyWorkspaceStackTransform();
      return;
    }
    if (!wasStacked.current) return;
    wasStacked.current = false;
    // The overview took the stage mid-switch and places it itself.
    if (staged) return;
    finishWorkspaceSwitch();
    stage.style.transform = "";
    scroller.scrollLeft = workspaceCamera(workspace.id) ?? 0;
  }, [stackRows, stacked, staged, workspace.id]);

  // Before the reveal below: leaving the overview hands the strip its scroll back first, so the
  // reveal finds the focused pane in place.
  useOverviewStage(overviewPhase, stage, scrollerRef, stageRef);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Reveal the committed focused pane with an imperative camera move after measuring its DOM.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const stage = stageRef.current;
    if (!scroller || !stage || stacked || staged || dragging) return;
    if (focusedPaneId === null || focusedLeft === null || focusedWidth === null) return;
    // The first render sizes the strip for the window's width, before the scroller is measured.
    if (scroller.clientWidth !== viewportWidth) return;
    const left = focusedLeft;
    const right = left + focusedWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    let target: number | null = null;
    if (left < viewLeft - 1) target = left;
    else if (right > viewRight + 1) target = Math.min(left, right - scroller.clientWidth);
    if (target === null) return;
    // The scroll lands at once and the stage springs there on the compositor.
    moveStripCamera(scroller, stage, target);
  }, [dragging, focusedLeft, focusedPaneId, focusedWidth, stacked, staged, viewportWidth]);

  useStripResizeScroll(
    scrollerRef,
    focusedSpanRef,
    !staged && !stacked && !narrow && maximizedTabId === null,
  );
  useStripScrollGestures(scrollerRef);

  // Center the focused column in the window (a one-shot scroll).
  const handledCenterRequest = useRef(centerRequest);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Scroll the DOM strip in response to an external center request.
  useLayoutEffect(() => {
    if (handledCenterRequest.current === centerRequest) return;
    handledCenterRequest.current = centerRequest;
    const scroller = scrollerRef.current;
    const stage = stageRef.current;
    if (!scroller || !stage || focusedLeft === null || focusedWidth === null) return;
    const target = Math.max(
      0,
      Math.min(
        stripPx - scroller.clientWidth,
        focusedLeft + focusedWidth / 2 - scroller.clientWidth / 2,
      ),
    );
    if (Math.abs(target - scroller.scrollLeft) < 1) return;
    moveStripCamera(scroller, stage, target);
  }, [centerRequest, focusedLeft, focusedWidth, stripPx]);

  // The first off-screen pane an agent opened on each side of the window.
  const [peeks, setPeeks] = useState<{ left: string | null; right: string | null }>({
    left: null,
    right: null,
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Track unseen panes against the committed scroll position, publishing only when a peek changes.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || stacked || staged) return;
    const compute = () => {
      const viewLeft = scroller.scrollLeft;
      const viewRight = viewLeft + scroller.clientWidth;
      let left: string | null = null;
      let right: string | null = null;
      const seen: string[] = [];
      for (const slot of own.slots) {
        const tabId = slot.activeTabId;
        if (tabId === null || !unseenTabIds.has(tabId)) continue;
        const start = slot.rect.left * stripPx;
        const end = start + slot.rect.width * stripPx;
        if (end <= viewLeft + 1) {
          if (left === null) left = tabId;
        } else if (start >= viewRight - 1) {
          if (right === null) right = tabId;
        } else seen.push(tabId);
      }
      if (seen.length > 0) useLayoutStore.getState().markTabsSeen(seen);
      setPeeks((current) =>
        current.left === left && current.right === right ? current : { left, right },
      );
    };
    compute();
    scroller.addEventListener("scroll", compute, { passive: true });
    return () => scroller.removeEventListener("scroll", compute);
  });

  // Where the strip's camera is, in half windows: it changes a couple of times per window of
  // scroll, not per frame, so scrolling re-renders the strip rarely.
  const [cameraStep, setCameraStep] = useState(0);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Subscribe to native scroll and schedule bounded render-window updates.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setCameraStep(Math.floor(scroller.scrollLeft / Math.max(1, viewportWidth / 2)));
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [viewportWidth]);

  const tabsById = new Map<string, { tab: LayoutTab; pane: LayoutPane }>();
  for (const candidate of shown.workspaces) {
    for (const column of candidate.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) tabsById.set(tab.id, { tab, pane });
      }
    }
  }
  const retainable = (tabId: string) => {
    const entry = tabsById.get(tabId);
    return entry !== undefined && retainTab !== undefined && retainTab(entry.tab);
  };
  const shownTabIds = new Set(placed.flatMap((entry) => entry.pane.activeTabId ?? []));
  // Mount newly shown tabs in the same render, then keep them mounted until they close, so a
  // workspace or tab switch preserves their drafts, scroll and terminals.
  const [retained, setRetained] = useState<readonly string[]>([]);
  const nextRetained = nextRetainedTabIds(
    [...shownTabIds].filter(retainable),
    retained,
    retainable,
  );
  if (!sameIds(nextRetained, retained)) setRetained(nextRetained);

  // The tabs near the camera render the first time they come near.
  const nearTabIds = (() => {
    if (staged) return nearTabIdsInOverview(stage.rows, viewportWidth, stage.scale);
    if (stacked) {
      return nearTabIdsOnStrip(
        stackRows.map((row) => ({
          slots: row.slots,
          rowPx: row.stripWidth * viewportWidth,
          camera: row.camera,
        })),
        viewportWidth,
      );
    }
    const rows = [{ slots: own.slots, rowPx: stripPx, camera: (cameraStep * viewportWidth) / 2 }];
    // Focus can land past the camera before the scroll reports it.
    if (focusedSlot) {
      rows.push({
        slots: [focusedSlot],
        rowPx: stripPx,
        camera: focusedSlot.rect.left * stripPx,
      });
    }
    return nearTabIdsOnStrip(rows, viewportWidth);
  })();
  const [recent, setRecent] = useState<readonly string[]>([]);
  const nextRecent = nextRecentTabIds(
    new Set([...nearTabIds].filter(retainable)),
    recent,
    retainable,
  );
  if (!sameIds(nextRecent, recent)) setRecent(nextRecent);
  const keptIds = keptTabIds(
    nearTabIds,
    recent,
    active ? (focusedPane?.activeTabId ?? null) : null,
    null,
  );

  // The pane each column focuses when focus follows the view back to it.
  const lastFocusedByColumn = useRef(new Map<string, string>());
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Remember the committed focused pane for later scroll-driven focus.
  useEffect(() => {
    if (focusedPaneId === null) return;
    const column = workspace.columns.find((candidate) =>
      candidate.panes.some((pane) => pane.id === focusedPaneId),
    );
    if (column) lastFocusedByColumn.current.set(column.id, focusedPaneId);
  }, [focusedPaneId, workspace]);

  // Which panes are on screen, and focus following the view as in niri: once a sideways scroll
  // of the user's settles with the focused pane under half on screen, the column most in view
  // takes focus. Derived from the slots and the settled scroll, never per frame.
  const reportOnScreen = useStableCallback((ids: ReadonlySet<string>) => onScreenTabsChange?.(ids));
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Subscribe to settled strip scrolling and publish the panes on screen and the focus that follows.
  useEffect(() => {
    if (!active) {
      reportOnScreen(NO_TABS);
      return;
    }
    if (dragging || staged || stacked) return;
    const scroller = scrollerRef.current;
    const compute = (settled: boolean) => {
      const slots = own.slots;
      // In shares of the strip, which the window may clip on the right.
      const measured = scroller !== null && stripPx > 0;
      const viewStart = measured ? scroller.scrollLeft / stripPx : 0;
      const viewEnd = measured ? (scroller.scrollLeft + scroller.clientWidth) / stripPx : 1;
      if (settled && measured && userStripScrollAge() <= USER_SCROLL_SETTLE_WINDOW_MS) {
        endUserStripScroll();
        const store = useLayoutStore.getState();
        const current = selectFocusedWorkspace(store.layout);
        const target = paneToFollow(
          current.columns,
          current.focusedPaneId,
          slots,
          viewStart,
          viewEnd,
          lastFocusedByColumn.current,
        );
        if (target !== null) store.focusPane(target);
      }
      reportOnScreen(tabIdsOnScreen(slots, viewStart, viewEnd));
    };
    compute(false);
    if (!scroller) return;
    let timer: number | null = null;
    const settle = () => {
      // The user's gesture may still be going between its scroll events.
      const age = userStripScrollAge();
      if (age < USER_SCROLL_END_MS) {
        timer = window.setTimeout(settle, USER_SCROLL_END_MS - age);
        return;
      }
      timer = null;
      compute(true);
    };
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(settle, ON_SCREEN_SCROLL_SETTLE_MS);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    // A render between a scroll and its settle re-subscribes: the settle still waits.
    if (userStripScrollAge() <= USER_SCROLL_SETTLE_WINDOW_MS) onScroll();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [active, dragging, own.slots, reportOnScreen, stacked, staged, stripPx]);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Clear the published panes when the strip unmounts.
  useEffect(() => () => reportOnScreen(NO_TABS), [reportOnScreen]);

  const focusPane = (paneId: string) => {
    if (useLayoutStore.getState().layout.workspaces.length === 0) return;
    const current = selectFocusedPane(useLayoutStore.getState().layout)?.id;
    if (current !== paneId) useLayoutStore.getState().focusPane(paneId);
  };
  const hiddenState = (tabId: string, paneId: string): LayoutPaneState => ({
    tabId,
    paneId,
    split,
    narrow: false,
    leadingEdge: false,
    trailingEdge: false,
    focused: false,
    related: false,
    visible: false,
    near: false,
    kept: keptIds.has(tabId),
  });
  // One stable sibling layer in tab order: a tab moving between shown and hidden changes only its
  // style, so its content is not remounted.
  const bodies = [
    ...placed.flatMap((entry) => {
      const tab = entry.pane.tabs.find((candidate) => candidate.id === entry.pane.activeTabId);
      return tab ? [{ tab, paneId: entry.pane.id, entry }] : [];
    }),
    ...retained.flatMap((tabId) => {
      const held = shownTabIds.has(tabId) ? undefined : tabsById.get(tabId);
      return held ? [{ tab: held.tab, paneId: held.pane.id, entry: null }] : [];
    }),
  ].toSorted((a, b) => a.tab.id.localeCompare(b.tab.id));
  const paneState = (entry: Placed, tabId: string): LayoutPaneState => {
    const widthPx = entry.slot.rect.width * entry.stripPx;
    return {
      tabId,
      paneId: entry.pane.id,
      split,
      narrow: split && widthPx < INLINE_PANEL_MIN_PX,
      // Zoomed out, the pane where the window will start keeps its inset; none touches the right.
      leadingEdge: overviewStarts
        ? overviewStarts.has(entry.pane.id)
        : edges.leading === null
          ? !entry.slot.hasLeft
          : edges.leading === entry.pane.id,
      trailingEdge: staged
        ? false
        : edges.trailing === null
          ? !entry.slot.hasRight
          : edges.trailing === entry.pane.id,
      // The overview owns the keys; the chat takes focus back when it closes.
      focused: active && !staged && entry.pane.id === focusedPaneId,
      related: false,
      visible: active,
      near: nearTabIds.has(tabId),
      kept: keptIds.has(tabId),
    };
  };

  return (
    <div ref={rootRef} className="relative h-full min-h-0 w-full">
      <LayoutStripScroller
        ref={scrollerRef}
        inactive={!active}
        mode={stacked ? "clip" : own.stripWidth > 1 && !staged ? "scroll" : "fit"}
        onPointerDown={staged ? onOverviewBackgroundPointerDown : undefined}
      >
        {staged ? (
          <LayoutOverviewBackdrop
            closing={overviewPhase === "closing"}
            style={overviewZoomTransition()}
          />
        ) : null}
        <LayoutStage
          ref={stageRef}
          staged={staged}
          style={
            staged
              ? undefined
              : stacked || own.fits
                ? { width: "100%" }
                : { width: `${stripPx}px`, minWidth: "100%" }
          }
        >
          {placed.map((entry) => {
            const placement = entry.slot.hasAbove ? "pane" : "window";
            const firstActive =
              entry.pane.tabs.length > 0 && entry.pane.tabs[0]!.id === entry.pane.activeTabId;
            const leading =
              entry.slot.hasAbove || staged
                ? undefined
                : edges.leading === entry.pane.id
                  ? windowBarLeading
                  : undefined;
            const trailing =
              entry.slot.hasAbove || staged
                ? undefined
                : edges.trailing === entry.pane.id
                  ? windowBarTrailing
                  : undefined;
            return (
              <LayoutPaneFrame
                key={entry.pane.id}
                data-layout-pane-id={entry.pane.id}
                data-layout-pane-focused={
                  active && !staged && entry.pane.id === focusedPaneId ? "true" : undefined
                }
                focused={active && !staged && entry.pane.id === focusedPaneId}
                inert={staged}
                placement={placement}
                squareStart={placement === "window" && firstActive}
                style={entry.style}
                onPointerDownCapture={() => focusPane(entry.pane.id)}
                bar={
                  <PaneBarOf
                    entry={entry}
                    placement={placement}
                    state={paneState(entry, entry.pane.activeTabId ?? "")}
                    tabLabel={tabLabel}
                    onAddTab={onAddTab}
                    onTabContextMenu={onTabContextMenu}
                    leading={leading}
                    trailing={trailing}
                  />
                }
              />
            );
          })}
          {bodies.map(({ tab, paneId, entry }) => {
            if (entry === null) {
              const state = hiddenState(tab.id, paneId);
              return (
                <LayoutPaneBody key={tab.id} hidden placement="window">
                  <LayoutPaneContext value={state}>{renderTab(tab, state)}</LayoutPaneContext>
                </LayoutPaneBody>
              );
            }
            const state = paneState(entry, tab.id);
            return (
              <LayoutPaneBody
                key={tab.id}
                data-layout-body-pane-id={paneId}
                data-layout-pane-focused={
                  active && !staged && paneId === focusedPaneId ? "true" : undefined
                }
                inert={staged}
                placement={entry.slot.hasAbove ? "pane" : "window"}
                style={entry.style}
                onPointerDownCapture={() => focusPane(paneId)}
              >
                <LayoutPaneContext value={state}>{renderTab(tab, state)}</LayoutPaneContext>
              </LayoutPaneBody>
            );
          })}
          {placed
            .filter((entry) => entry.pane.activeTabId === null)
            .map((entry) => (
              <LayoutPaneBody
                key={`empty:${entry.pane.id}`}
                placement={entry.slot.hasAbove ? "pane" : "window"}
                style={entry.style}
              >
                <LayoutEmptyPane />
              </LayoutPaneBody>
            ))}
          {emptyRows.map((row) => (
            <LayoutEmptyWorkspaceFrame
              key={row.id}
              data-layout-empty-workspace={row.id}
              drawn
              style={row.style}
              inert={!row.own || !active}
              onPointerDownCapture={undefined}
            >
              <LayoutPaneContext
                value={{
                  tabId: null,
                  paneId: null,
                  split: !row.own,
                  narrow: false,
                  leadingEdge: true,
                  trailingEdge: true,
                  focused: row.own && active,
                  related: false,
                  visible: true,
                  near: true,
                  kept: true,
                }}
              >
                <LayoutLauncherShell tabId={null}>{empty}</LayoutLauncherShell>
              </LayoutPaneContext>
            </LayoutEmptyWorkspaceFrame>
          ))}
          {staged ? (
            <OverviewStageOverlay
              layout={shown}
              stage={stage}
              phase={overviewPhase}
              resolveTabLabel={(tab) => {
                const label = tabLabel(tab);
                return { icon: label.icon ?? null, title: label.title };
              }}
            />
          ) : null}
          {!stacked && !staged && own.slots.length > 1 ? (
            <LayoutResizeHandles
              layout={layout}
              workspace={workspace}
              slots={own.slots}
              stripWidth={stripPx / own.unitWidth}
              unitWidth={own.unitWidth}
              scrollerRef={scrollerRef}
              onPreview={setPreview}
            />
          ) : null}
        </LayoutStage>
        {preview ? <LayoutHeldWidth width={preview.heldStripPx} /> : null}
      </LayoutStripScroller>
      {active && peeks.left && !stacked ? (
        <LayoutPeekDot
          side="left"
          label="New pane to the left"
          onClick={() => useLayoutStore.getState().focusTab(peeks.left!)}
        />
      ) : null}
      {active && peeks.right && !stacked ? (
        <LayoutPeekDot
          side="right"
          label="New pane to the right"
          onClick={() => useLayoutStore.getState().focusTab(peeks.right!)}
        />
      ) : null}
    </div>
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function fullSlot(): LayoutPaneSlot {
  return {
    paneId: "",
    activeTabId: null,
    rect: { ...FULL_RECT },
    hasLeft: false,
    hasRight: false,
    hasAbove: false,
    hasBelow: false,
  };
}

function PaneBarOf({
  entry,
  placement,
  state,
  tabLabel,
  onAddTab,
  onTabContextMenu,
  leading,
  trailing,
}: {
  entry: Placed;
  placement: "pane" | "window";
  state: LayoutPaneState;
  tabLabel: (tab: LayoutTab) => LayoutTabLabel;
  onAddTab: ((paneId: string) => void) | undefined;
  onTabContextMenu: ((tab: LayoutTab, position: { x: number; y: number }) => void) | undefined;
  leading: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <LayoutPaneContext value={state}>
      <LayoutPaneTabBar
        paneId={entry.pane.id}
        tabs={entry.pane.tabs}
        activeTabId={entry.pane.activeTabId}
        placement={placement}
        tabLabel={tabLabel}
        {...(onAddTab ? { onAdd: onAddTab } : {})}
        {...(onTabContextMenu ? { onTabContextMenu } : {})}
        leading={leading}
        trailing={trailing}
      />
    </LayoutPaneContext>
  );
}
