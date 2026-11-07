import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { StreamingGlyph } from "../chat/TimelineRowParts";

/**
 * What a thread row's status line can say, one kind per word. This is the app's
 * single status vocabulary: the grid rail, the grid pane label, the sidebar,
 * the tasks page and the command palette all draw these marks.
 */
export type ThreadStatusKind =
  | "ready"
  | "running"
  | "waiting"
  | "goal"
  | "approval"
  | "input"
  | "request"
  | "needs"
  | "limited"
  | "failed"
  | "back"
  | "idle"
  | "closed";

/** The coarse states a status pill names; each maps to one kind of the same name. */
export type ThreadState = Extract<
  ThreadStatusKind,
  "running" | "ready" | "needs" | "failed" | "back"
>;

/**
 * Status ink is the `-ink` token: `--accent` and `--primary` are fills (buttons,
 * focus rings, selection bars) and read too dark when used as text.
 */
export const THREAD_STATUS_KIND_TEXT_CLASS: Record<ThreadStatusKind, string> = {
  approval: "text-(--warn-ink)",
  input: "text-(--warn-ink)",
  request: "text-(--warn-ink)",
  needs: "text-(--warn-ink)",
  limited: "text-(--warn-ink)",
  failed: "text-error-foreground",
  waiting: "text-info-foreground",
  running: "text-(--accent-ink)",
  goal: "text-(--accent-ink)",
  back: "text-merged-foreground",
  ready: "text-success-foreground",
  idle: "text-secondary-label",
  closed: "text-secondary-label",
};

export const THREAD_STATE_TEXT_CLASS: Record<ThreadState, string> = {
  running: THREAD_STATUS_KIND_TEXT_CLASS.running,
  ready: THREAD_STATUS_KIND_TEXT_CLASS.ready,
  needs: THREAD_STATUS_KIND_TEXT_CLASS.needs,
  failed: THREAD_STATUS_KIND_TEXT_CLASS.failed,
  back: THREAD_STATUS_KIND_TEXT_CLASS.back,
};

export function threadStateTextClass(state: ThreadState): string {
  return THREAD_STATE_TEXT_CLASS[state];
}

export function threadStatusKindTextClass(kind: ThreadStatusKind): string {
  return THREAD_STATUS_KIND_TEXT_CLASS[kind];
}

const CALM_KINDS: ReadonlySet<ThreadStatusKind> = new Set(["ready", "idle", "closed"]);

/** The status word's class: a calm kind names itself in the muted ink, every other in its hue. */
export function threadStatusWordClass(kind: ThreadStatusKind): string {
  return CALM_KINDS.has(kind)
    ? "text-secondary-label"
    : `font-medium ${THREAD_STATUS_KIND_TEXT_CLASS[kind]}`;
}

/**
 * One 14px shape per kind: a 24-unit circle of r=8.5 with an inner mark, drawn
 * with `currentColor` so the kind's hue paints it. Running keeps the 8-dot ring.
 */
const STATUS_KIND_SHAPE: Record<Exclude<ThreadStatusKind, "running">, ReactNode> = {
  ready: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>
  ),
  waiting: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.6 12h.1M12 12h.1M15.4 12h.1" strokeWidth={2.6} />
    </>
  ),
  goal: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </>
  ),
  approval: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.6l3.3 1.3v2.5c0 2.1-1.4 3.6-3.3 4.4-1.9-.8-3.3-2.3-3.3-4.4V8.9z" />
    </>
  ),
  input: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 1.9-2.2 3.2" />
      <path d="M12 16.6v.1" />
    </>
  ),
  request: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <rect x="8.3" y="9.3" width="7.4" height="5.4" rx="1" />
      <path d="m8.6 9.8 3.4 2.5 3.4-2.5" />
    </>
  ),
  needs: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v5" />
      <path d="M12 16.2v.1" />
    </>
  ),
  limited: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.2 14.6a3.8 3.8 0 0 1 7.6 0" />
      <path d="m12 14.6 1.9-2.6" />
    </>
  ),
  failed: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9.4 9.4 5.2 5.2M14.6 9.4l-5.2 5.2" />
    </>
  ),
  back: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v3.2l2 1.4M5 5.5 7.5 3.5M19 5.5l-2.5-2" />
    </>
  ),
  idle: <circle cx="12" cy="12" r="8.5" />,
  closed: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 12h6" />
    </>
  ),
};

/**
 * The status glyph of a thread: a distinct 14px shape for each kind. Only the
 * running ring turns, and it stands still under reduced motion.
 */
export function ThreadStatusKindGlyph({
  kind,
  className,
}: {
  kind: ThreadStatusKind;
  className?: string | undefined;
}) {
  if (kind === "running") {
    return <StreamingGlyph className={className} statusKind="running" />;
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      data-status-kind={kind}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
    >
      {STATUS_KIND_SHAPE[kind]}
    </svg>
  );
}

/** The coarse state's mark, for callers that only know a status pill. */
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
  return <ThreadStatusKindGlyph kind={state} className={cn(ink, className)} />;
}
