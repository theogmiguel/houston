import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  resolveThreadDetailsCardDensity,
} from "./threadDetailsCardLayout";
import { observeResize } from "../../lib/observeResize";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
import { readInlineDetailsHandoff, recordInlineDetailsHandoff } from "./inlineDetailsFollow";

// The grid cannot paint a card across its cell borders, so a focus move becomes a short
// slide and fade from the previous cell's side instead of a full cross-cell flight.
const FOLLOW_OFFSET_MAX_X = 28;
const FOLLOW_OFFSET_MAX_Y = 16;
const FOLLOW_DURATION_MS = 200;

const cappedOffset = (delta: number, max: number) =>
  Math.sign(delta) * Math.min(Math.abs(delta), max);

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  contentKey,
  defaultOpen = true,
  allowInline = true,
  open,
  onOpenChange,
  animateFollow = false,
  onContextMenu,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  /** Changes when the set of rendered items changes, so cached heights are measured again. */
  contentKey: string;
  /** Route threads open by default; a grid cell stays closed until its top bar toggles it. */
  defaultOpen?: boolean;
  /** Compact and glance grid panes have no room for an inline card, so they only pop over. */
  allowInline?: boolean;
  /** A grid owns its one details flag, so it controls the card instead of the thread store. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A grid focus move slides the inline card in from the cell that lost focus. */
  animateFollow?: boolean;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}) {
  const detailsArea = workspaceAreaProps("details", 3, "Thread details");
  const canvas = useChatCanvas();
  const preferredPlacement = canvas?.preferredDetailsCard ?? null;
  const placement = canvas?.detailsCardPlacement ?? null;
  const mode = allowInline && placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const controlled = open !== undefined;
  const storedInlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline", defaultOpen),
  );
  const storedPopoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      threadRef,
      "popover",
      defaultOpen,
    ),
  );
  const inlineOpen = open ?? storedInlineOpen;
  const popoverOpen = open ?? storedPopoverOpen;
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${preferredPlacement?.width ?? "popup"}:${contentKey}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = resolveThreadDetailsCardDensity(height, contentHeights);
  const measureDetailsCard = canvas?.measureDetailsCard;
  const cardWidth = preferredPlacement?.width;
  // The mode derives from canvas measurements, the preview frame and the
  // inline flag, which live in three stores, so no single write site sees the
  // card leave popover mode. A flag left set would reopen the popover unasked
  // when the card returns to popover mode.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover flag in the right panel store when the derived mode turns inline
  useLayoutEffect(() => {
    if (!controlled && mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [controlled, mode, popoverOpen, threadRef]);
  // The grid moves an open inline card to the cell that gains focus; it reads
  // this instead of guessing from the two open flags.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the presentation this card actually renders to the right panel store
  useLayoutEffect(() => {
    useRightPanelStore.getState().setThreadPanelPresentation(threadRef, mode);
  }, [mode, threadRef]);
  const asideRef = useRef<HTMLElement | null>(null);
  const threadKey = scopedThreadKey(threadRef);
  // The grid hands the card's rect from the cell that lost focus to the cell that gained
  // it; the new card slides in from that side. A fresh opening has no handoff.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the inline card's rect and animates it when a grid cell gains focus
  useLayoutEffect(() => {
    if (!animateFollow) return;
    const element = asideRef.current;
    if (mode !== "inline" || !inlineOpen || element === null) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const previous = readInlineDetailsHandoff();
    if (
      previous.threadKey !== null &&
      previous.threadKey !== threadKey &&
      previous.rect !== null &&
      !prefersReducedMotion()
    ) {
      const dx = cappedOffset(previous.rect.left - rect.left, FOLLOW_OFFSET_MAX_X);
      const dy = cappedOffset(previous.rect.top - rect.top, FOLLOW_OFFSET_MAX_Y);
      element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
          { transform: "translate(0px, 0px)", opacity: 1 },
        ],
        { duration: FOLLOW_DURATION_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    }
    recordInlineDetailsHandoff(threadKey, rect);
  }, [animateFollow, inlineOpen, mode, placement, threadKey]);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  // A grid cell renders its own pane head and omits the route header that owns the
  // details button, so the popover anchors to the cell's top right instead of the viewport.
  // State, not a ref: the popover anchor is derived during render, and reading a ref
  // there makes the React Compiler skip the component.
  const [fallbackAnchorElement, setFallbackAnchorElement] = useState<HTMLSpanElement | null>(null);
  const { environmentId, threadId } = threadRef;
  // Re-measures when the density or measurement key changes, so each density's
  // height is measured once it renders.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the card's DOM height via ResizeObserver and reports it to the canvas
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // PR lists, lineage and side chats scroll as they expand. Counting them toward density
      // would hide the section and workspace controls when the user asks to see more rows.
      const lists = element.querySelectorAll<HTMLElement>(
        "[data-thread-relationships-panel], [data-thread-side-chats-panel], [data-thread-details-pr-list]",
      );
      const fittingHeight =
        next - Array.from(lists).reduce((sum, list) => sum + list.offsetHeight, 0);
      setMeasurements((current) => {
        const heights = current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        return current.key === measurementKey && heights[density] === fittingHeight
          ? current
          : { key: measurementKey, heights: { ...heights, [density]: fittingHeight } };
      });
      // Only the laid-out DOM knows the full card height, and the canvas keeps preview
      // frames clear of it, so it is reported from this measure effect.
      if (density === "full" && cardWidth !== undefined) {
        measureDetailsCard?.({
          threadRef: { environmentId, threadId },
          width: cardWidth,
          fullContentHeight: next,
        });
      }
    };
    measure();
    return observeResize(element, measure);
  }, [
    contentElement,
    density,
    measurementKey,
    cardWidth,
    measureDetailsCard,
    environmentId,
    threadId,
  ]);
  const popoverAnchor =
    anchor.current ??
    (fallbackAnchorElement
      ? {
          getBoundingClientRect: () => {
            const cell = fallbackAnchorElement.closest<HTMLElement>(
              "[data-grid-cell], [data-grid-empty-draft]",
            );
            const rect = (cell ?? fallbackAnchorElement).getBoundingClientRect();
            return new DOMRect(rect.left, rect.top + 34, rect.width, 0);
          },
        }
      : undefined);
  const card = (
    <div
      className={cn(
        "isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-xl bg-[var(--surface-raised)] shadow-[var(--shadow-1)]",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      style={placement ? { maxHeight: height } : undefined}
      onContextMenu={onContextMenu}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <div ref={setContentElement} className="py-1">
          {children(density)}
        </div>
      </ScrollArea>
    </div>
  );
  return (
    <>
      <span ref={setFallbackAnchorElement} aria-hidden className="hidden" />
      <Popover
        handle={handle}
        open={mode === "popover" && popoverOpen}
        onOpenChange={(open, details) => {
          const target =
            details.reason === "focus-out"
              ? (details.event as FocusEvent).relatedTarget
              : details.reason === "outside-press"
                ? details.event.target
                : null;
          if (!open && target instanceof Element && target.closest("[data-thread-find-bar]")) {
            details.cancel();
            return;
          }
          // The grid's details button closes the popover itself; letting the outside press
          // close it first would make the same click reopen it.
          if (
            controlled &&
            !open &&
            target instanceof Element &&
            target.closest('[aria-label="Toggle thread details panel"]')
          ) {
            details.cancel();
            return;
          }
          if (controlled) {
            onOpenChange?.(open);
            return;
          }
          useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open);
        }}
      >
        {placement && inlineOpen ? (
          <aside
            ref={asideRef}
            {...detailsArea}
            data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
            // Skip the return transition to avoid overlapping the rising preview.
            className={cn(
              "absolute z-20",
              topInset > 0 &&
                "transition-[top] duration-150 ease-out motion-reduce:transition-none",
            )}
            style={{
              right: placement.right,
              top: placement.y,
              width: placement.width,
              maxHeight: height,
            }}
            data-density={density}
            data-thread-details-panel="inline"
          >
            {card}
          </aside>
        ) : null}
        {/* Rendered in both modes: base-ui keeps a popup that unmounts mid-open
          mounted, because its exit animation never finishes. Staying in the tree
          lets it close cleanly when the card switches inline. */}
        <PopoverPopup
          {...(mode === "popover" ? detailsArea : {})}
          role="dialog"
          data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
          initialFocus={() => {
            requestWorkspaceFocus({ area: "details" });
            return false;
          }}
          anchor={popoverAnchor}
          align="end"
          // Account for the find panel's 8px card padding.
          alignOffset={THREAD_DETAILS_CARD_GAP - 8}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={topInset}
          variant="panel"
          padding="none"
        >
          {mode === "popover" ? (
            <div data-density={density} data-thread-details-panel="popover">
              {card}
            </div>
          ) : null}
        </PopoverPopup>
      </Popover>
    </>
  );
}
