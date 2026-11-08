import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * Gap between the items of a row's second line, in px. It matches the `gap-2` of the line, which
 * the overflow arithmetic needs to know.
 */
const ROW_META_GAP_PX = 8;

/**
 * Room reserved for the "+N" counter when items are dropped, in px: its gap plus a two-digit
 * count at 12px. Measured against the rendered counter (about 22px) with a little slack.
 */
const ROW_META_COUNTER_PX = 30;

/**
 * One whole item of a row's second line. The line drops items from the right when they do not fit;
 * `label` names a dropped item in the counter's tooltip and accessible name, `minWidth` is the
 * narrowest the item can be (a branch name ellipsizes to it), and `keep` exempts the item from
 * dropping.
 */
export function RowMetaItem({
  label,
  minWidth,
  keep = false,
  className,
  children,
}: {
  label: string;
  minWidth?: number;
  keep?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-meta-item=""
      data-meta-label={label}
      data-meta-min-width={minWidth}
      data-meta-keep={keep ? "" : undefined}
      style={minWidth === undefined ? undefined : { minWidth }}
      className={cn(
        "inline-flex items-center",
        minWidth === undefined ? "shrink-0" : "min-w-0 shrink",
        className,
      )}
    >
      {children}
    </span>
  );
}

interface FitResult {
  readonly hidden: ReadonlyArray<boolean>;
  readonly labels: ReadonlyArray<string>;
}

/**
 * Which items of a line fit in `available` px. Items drop from the right, whole, and an item
 * marked `keep` stays. When something drops, the counter's width is reserved.
 */
export function fitMetaItems(
  items: ReadonlyArray<{ width: number; keep: boolean; label: string }>,
  available: number,
): FitResult {
  const widthOf = (count: number): number =>
    items.slice(0, count).reduce((sum, item) => sum + item.width, 0) +
    ROW_META_GAP_PX * Math.max(0, count - 1);
  if (widthOf(items.length) <= available) {
    return { hidden: items.map(() => false), labels: [] };
  }
  const limit = available - ROW_META_COUNTER_PX;
  let count = items.length;
  while (count > 0 && widthOf(count) > limit) count -= 1;
  // An item that must stay is never dropped, whatever the width.
  const lastKept = items.reduce((last, item, index) => (item.keep ? index : last), -1);
  count = Math.max(count, lastKept + 1);
  const hidden = items.map((_, index) => index >= count);
  return {
    hidden,
    labels: items.filter((_, index) => hidden[index]).map((item) => item.label),
  };
}

/**
 * A row's second line: items in a fixed order with a "+N" counter for the ones that do not fit.
 * Dropped items stay in the DOM, laid out but invisible and out of the tab order, so their widths
 * stay measurable and they return as soon as the line is wide enough.
 */
export function RowMeta({ children }: { children: ReactNode }) {
  const lineRef = useRef<HTMLDivElement | null>(null);
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlyArray<string>>([]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures the rendered line and hides the items that overflow it; the width is layout state only the DOM knows
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (line === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const elements = [...line.querySelectorAll<HTMLElement>(":scope > [data-meta-item]")];
      const fit = fitMetaItems(
        elements.map((element) => ({
          width:
            element.dataset.metaMinWidth === undefined
              ? element.offsetWidth
              : Number(element.dataset.metaMinWidth),
          keep: element.dataset.metaKeep !== undefined,
          label: element.dataset.metaLabel ?? "",
        })),
        line.clientWidth,
      );
      elements.forEach((element, index) => {
        const hide = fit.hidden[index] === true;
        if (hide) {
          element.dataset.metaHidden = "";
          element.setAttribute("aria-hidden", "true");
        } else {
          delete element.dataset.metaHidden;
          element.removeAttribute("aria-hidden");
        }
      });
      setHiddenLabels((current) =>
        current.length === fit.labels.length && current.every((l, i) => l === fit.labels[i])
          ? current
          : fit.labels,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    const stopResize = observeResize(line, measure);
    const mutation = new MutationObserver(schedule);
    mutation.observe(line, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      stopResize();
      mutation.disconnect();
    };
  }, []);

  const hiddenSummary = hiddenLabels.join(", ");
  return (
    <div
      ref={lineRef}
      data-thread-meta-items=""
      className="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden [&>[data-meta-hidden]]:pointer-events-none [&>[data-meta-hidden]]:invisible [&>[data-meta-hidden]]:absolute"
    >
      {children}
      {hiddenLabels.length === 0 ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={`${hiddenLabels.length} more: ${hiddenSummary}`}
                data-thread-meta-overflow=""
                className="inline-flex shrink-0 items-center tabular-nums"
              />
            }
          >
            +{hiddenLabels.length}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {hiddenLabels.map((label) => (
              <span key={label} className="block">
                {label}
              </span>
            ))}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
