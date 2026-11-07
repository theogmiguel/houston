import type { ThreadCheckpointSummary } from "@houston-app/client-runtime/state/thread-checkpoints";
import { checkpointFileTotals } from "@houston-app/client-runtime/state/thread-checkpoints";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import {
  CHANGED_FILES_BANNER_CLS,
  CHANGED_FILES_ROW_CLS,
  CHANGED_FILES_TOGGLE_CLS,
} from "../ui/composer-anatomy-recipes";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

export interface ChangedFilesBarProps {
  readonly summary: Pick<ThreadCheckpointSummary, "files" | "filesTotal">;
  readonly onReview: () => void;
  readonly onUndo?: (() => void) | undefined;
  readonly onKeep?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * `row` is the right side of the composer's context row (no frame of its own); `bar` is the
   * standalone banner a narrow composer keeps above its card.
   */
  readonly variant?: "row" | "bar" | undefined;
}

/**
 * The pending turn's changes: the review entry point and the two bulk actions. Undo and Keep
 * read short in the row and keep their full names as accessible names and tooltips.
 */
export const ChangedFilesBar = memo(function ChangedFilesBar({
  summary,
  onReview,
  onUndo,
  onKeep,
  disabled = false,
  variant = "bar",
}: ChangedFilesBarProps) {
  const totals = checkpointFileTotals(summary);
  if (totals.count === 0) return null;
  const inRow = variant === "row";
  const label = `${totals.count.toLocaleString()} file${totals.count === 1 ? "" : "s"} changed`;
  return (
    <div
      data-changed-files-bar="true"
      data-variant={variant}
      className={inRow ? CHANGED_FILES_ROW_CLS : CHANGED_FILES_BANNER_CLS}
    >
      <button
        type="button"
        onClick={onReview}
        className={CHANGED_FILES_TOGGLE_CLS}
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
      {inRow ? null : <span className="flex-1" />}
      <span aria-hidden className="h-4 w-px shrink-0 bg-(--divider)" />
      <BulkAction
        label="Undo"
        fullName="Undo all"
        onClick={onUndo}
        disabled={disabled || onUndo === undefined}
      />
      <BulkAction
        label="Keep"
        fullName="Keep all"
        onClick={onKeep}
        disabled={disabled || onKeep === undefined}
      />
      <Button type="button" size="xs" variant="default" onClick={onReview} disabled={disabled}>
        Review
      </Button>
    </div>
  );
});

function BulkAction(props: {
  label: string;
  fullName: string;
  onClick: (() => void) | undefined;
  disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={props.fullName}
            onClick={props.onClick}
            disabled={props.disabled}
          />
        }
      >
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.fullName}</TooltipPopup>
    </Tooltip>
  );
}
