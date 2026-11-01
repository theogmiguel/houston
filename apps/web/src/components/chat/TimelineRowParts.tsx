import { type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

const STREAMING_DOT_COUNT = 8;
const STREAMING_DOT_ORBIT = 4.8;
const STREAMING_DOT_RADIUS = 0.62;
const STREAMING_DOTS = Array.from({ length: STREAMING_DOT_COUNT }, (_, index) => {
  const angle = (index / STREAMING_DOT_COUNT) * Math.PI * 2;
  return {
    cx: 7 + STREAMING_DOT_ORBIT * Math.cos(angle),
    cy: 7 + STREAMING_DOT_ORBIT * Math.sin(angle),
  };
});

/**
 * The working arc: a ring of dots that turns while the agent is running. The dots
 * are geometry rather than a dashed stroke so the gap survives every webview and
 * the paint comes from CSS, not an SVG presentation attribute.
 */
export function StreamingGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      data-streaming-glyph=""
      viewBox="0 0 14 14"
      className={cn(
        "size-3.5 shrink-0 animate-spin text-(--accent-ink) [animation-duration:1.1s] motion-reduce:animate-none",
        className,
      )}
    >
      {STREAMING_DOTS.map((dot, index) => (
        <circle
          key={index}
          data-streaming-dot=""
          cx={dot.cx}
          cy={dot.cy}
          r={STREAMING_DOT_RADIUS}
          style={{ fill: "currentColor" }}
        />
      ))}
    </svg>
  );
}
