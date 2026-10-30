import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { checkpointFileTotals } from "@t3tools/client-runtime/state/thread-checkpoints";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

export interface ChangedFilesBarProps {
  readonly summary: Pick<ThreadCheckpointSummary, "files" | "filesTotal">;
  readonly onReview: () => void;
  readonly onUndo?: (() => void) | undefined;
  readonly onKeep?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * The changed-files summary above the composer: one row for the turn's files,
 * with the review entry point and the two bulk actions.
 */
export const ChangedFilesBar = memo(function ChangedFilesBar({
  summary,
  onReview,
  onUndo,
  onKeep,
  disabled = false,
}: ChangedFilesBarProps) {
  const totals = checkpointFileTotals(summary);
  if (totals.count === 0) return null;
  const label = `${totals.count.toLocaleString()} file${totals.count === 1 ? "" : "s"} changed`;
  return (
    <div
      data-changed-files-bar="true"
      className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-2.5"
    >
      <button
        type="button"
        onClick={onReview}
        className="flex min-w-0 items-center gap-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`Review ${label}`}
      >
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </button>
      {hasNonZeroStat(totals) ? (
        <DiffStatLabel
          additions={totals.additions}
          deletions={totals.deletions}
          layout="inline"
          className="text-xs"
        />
      ) : null}
      <span className="flex-1" />
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        onClick={onUndo}
        disabled={disabled || onUndo === undefined}
      >
        Undo all
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        onClick={onKeep}
        disabled={disabled || onKeep === undefined}
      >
        Keep all
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={onReview} disabled={disabled}>
        Review
      </Button>
    </div>
  );
});
