import type { IconNode } from "morphicons/react";

import { cn } from "../../lib/utils";
import { StreamingGlyph } from "../chat/TimelineRowParts";
import { MorphIcon } from "../MorphIcon";

/**
 * The one thread-status vocabulary. The grid rail, the grid pane label, the
 * sidebar and the command palette draw these marks, so a state looks the same
 * wherever it appears.
 */
export type ThreadState = "running" | "ready" | "needs" | "failed" | "back";

/**
 * Status ink is the `-ink` token: `--accent` and `--primary` are fills (buttons,
 * focus rings, selection bars) and read too dark when used as text.
 */
export const THREAD_STATE_TEXT_CLASS: Record<ThreadState, string> = {
  running: "text-(--accent-ink)",
  ready: "text-success-foreground",
  needs: "text-(--warn-ink)",
  failed: "text-error-foreground",
  back: "text-secondary-foreground",
};

export function threadStateTextClass(state: ThreadState): string {
  return THREAD_STATE_TEXT_CLASS[state];
}

const THREAD_STATE_ICON: Record<Exclude<ThreadState, "running">, IconNode> = {
  ready: [
    ["circle", { cx: 12, cy: 12, r: 8.5 }],
    ["path", { d: "m8.5 12.2 2.4 2.4 4.6-4.8" }],
  ],
  needs: [
    ["circle", { cx: 12, cy: 12, r: 8.5 }],
    ["path", { d: "M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 1.9-2.2 3.2" }],
    ["path", { d: "M12 16.6v.1" }],
  ],
  failed: [
    ["circle", { cx: 12, cy: 12, r: 8.5 }],
    ["path", { d: "M12 7.8v5" }],
    ["path", { d: "M12 16.2v.1" }],
  ],
  back: [
    ["circle", { cx: 12, cy: 13, r: 7 }],
    ["path", { d: "M12 10v3.2l2 1.4M5 5.5 7.5 3.5M19 5.5l-2.5-2" }],
  ],
};

/** The state's mark, painted with `currentColor`; callers set the state's ink. */
export function ThreadStateGlyph({
  state,
  className,
  colored = false,
}: {
  state: ThreadState;
  className?: string | undefined;
  /** Paint the glyph with the state's ink instead of the caller's currentColor. */
  colored?: boolean;
}) {
  const ink = colored ? threadStateTextClass(state) : "";
  if (state === "running") {
    return <StreamingGlyph className={cn("size-3.5", ink, className)} />;
  }
  return (
    <MorphIcon
      className={cn("size-3.5 shrink-0", ink, className)}
      icon={THREAD_STATE_ICON[state]}
      strokeWidth={2}
    />
  );
}
