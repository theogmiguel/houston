import { InlineButton } from "../ui/button";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "../../lib/utils";

export function ExpandableText({
  text,
  collapsedText = text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: {
  text: string;
  collapsedText?: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const collapsed = collapsedText === text;
  const canExpand = collapsedText !== text || text.length > 180 || text.includes("\n") || clipped;

  // A length threshold misses text that wraps past the clamp in a narrow container.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures the clamped DOM box and refits it through a ResizeObserver
  useLayoutEffect(() => {
    const element = textRef.current;
    if (expanded || !collapsed || element === null) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    return observeResize(element, measure);
  }, [collapsed, expanded]);

  return (
    <div className={cn("min-w-0", className)}>
      <div
        id={textId}
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap break-words",
          // Clamp before measuring: the clip check reads this box's overflow.
          !expanded ? collapsedClassName : null,
        )}
      >
        {expanded ? text : collapsedText}
      </div>
      {canExpand ? (
        <InlineButton
          aria-expanded={expanded}
          aria-controls={textId}
          tone="muted"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : expandLabel}
        </InlineButton>
      ) : null}
    </div>
  );
}
