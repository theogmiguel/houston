import type { ReactNode } from "react";

import type { ThreadStatusKind } from "../../grid/statusWord";
import { cn } from "../../lib/utils";

/**
 * The hue of each status kind. Attention kinds carry their hue on the glyph and on the word;
 * the calm kinds (ready, idle, closed) keep the word muted, so only what asks for the user stands
 * out down a list.
 */
const STATUS_KIND_TEXT_CLASS: Record<ThreadStatusKind, string> = {
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

const CALM_KINDS: ReadonlySet<ThreadStatusKind> = new Set(["ready", "idle", "closed"]);

export function threadStatusKindTextClass(kind: ThreadStatusKind): string {
  return STATUS_KIND_TEXT_CLASS[kind];
}

/** The status word's class: a calm kind names itself in the muted ink, every other in its hue. */
export function threadStatusWordClass(kind: ThreadStatusKind): string {
  return CALM_KINDS.has(kind)
    ? "text-secondary-label"
    : `font-medium ${STATUS_KIND_TEXT_CLASS[kind]}`;
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** One 14px shape per kind, drawn with `currentColor` so the kind's hue paints it. */
const STATUS_KIND_SHAPE: Record<ThreadStatusKind, ReactNode> = {
  ready: (
    <>
      <circle cx="7" cy="7" r="6" {...STROKE} strokeWidth="1.2" opacity=".55" />
      <path d="M3.5 7.2l2.3 2.3 4.7-4.9" {...STROKE} strokeWidth="1.6" />
    </>
  ),
  back: <path d="M5 3.5L2.5 6 5 8.5M2.8 6h5.7a3 3 0 010 6H6" {...STROKE} strokeWidth="1.5" />,
  failed: (
    <>
      <circle cx="7" cy="7" r="6" fill="currentColor" opacity=".18" />
      <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.3" />
      <path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" {...STROKE} strokeWidth="1.5" />
    </>
  ),
  waiting: (
    <path
      d="M4 2h6M4 12h6M4.5 2c0 3 5 3 5 5s-5 2-5 5M9.5 2c0 3-5 3-5 5"
      {...STROKE}
      strokeWidth="1.4"
    />
  ),
  input: (
    <path
      d="M2 3.5a1.5 1.5 0 011.5-1.5h7A1.5 1.5 0 0112 3.5v5A1.5 1.5 0 0110.5 10H6l-3 2.2V10h0A1 1 0 012 9z"
      {...STROKE}
      strokeWidth="1.4"
    />
  ),
  approval: (
    <>
      <path
        d="M7 1.5l4.5 1.8v3.4c0 2.8-2 4.8-4.5 5.8-2.5-1-4.5-3-4.5-5.8V3.3z"
        fill="currentColor"
        opacity=".2"
      />
      <path
        d="M7 1.5l4.5 1.8v3.4c0 2.8-2 4.8-4.5 5.8-2.5-1-4.5-3-4.5-5.8V3.3z"
        {...STROKE}
        strokeWidth="1.3"
      />
    </>
  ),
  request: (
    <>
      <path d="M2 4.5l5 3.5 5-3.5" {...STROKE} strokeWidth="1.4" />
      <rect x="2" y="3" width="10" height="8" rx="1.5" {...STROKE} strokeWidth="1.4" />
    </>
  ),
  needs: (
    <>
      <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.4" />
      <path d="M7 4.2v3.4M7 9.8v.1" {...STROKE} strokeWidth="1.6" />
    </>
  ),
  limited: (
    <>
      <path d="M2 10.5a5 5 0 0110 0" {...STROKE} strokeWidth="1.4" />
      <path d="M7 10.5L9.3 6.8" {...STROKE} strokeWidth="1.4" />
    </>
  ),
  running: (
    <>
      <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.6" opacity=".25" />
      <path d="M7 1.5a5.5 5.5 0 015.5 5.5" {...STROKE} strokeWidth="1.6" />
    </>
  ),
  goal: (
    <>
      <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.3" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  idle: <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.3" opacity=".7" />,
  closed: (
    <>
      <circle cx="7" cy="7" r="5.5" {...STROKE} strokeWidth="1.3" opacity=".7" />
      <path d="M4.8 7h4.4" {...STROKE} strokeWidth="1.4" />
    </>
  ),
};

/**
 * The status glyph of a row: a distinct 14px shape for each status kind. Only the running spinner
 * turns, and it stands still under reduced motion.
 */
export function ThreadStatusKindGlyph({
  kind,
  className,
}: {
  kind: ThreadStatusKind;
  className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      data-status-kind={kind}
      className={cn(
        "size-3.5 shrink-0",
        kind === "running" && "animate-spin [animation-duration:1.1s] motion-reduce:animate-none",
        className,
      )}
    >
      {STATUS_KIND_SHAPE[kind]}
    </svg>
  );
}
