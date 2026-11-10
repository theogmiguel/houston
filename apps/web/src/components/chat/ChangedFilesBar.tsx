import type { ThreadCheckpointSummary } from "@houston-app/client-runtime/state/thread-checkpoints";
import { checkpointFileTotals } from "@houston-app/client-runtime/state/thread-checkpoints";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, FileIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import {
  CHANGED_FILES_BAR_CLS,
  CHANGED_FILES_CHEVRON_CLS,
  CHANGED_FILES_LIST_CLS,
  CHANGED_FILES_ROW_CLS,
  CHANGED_FILES_ROW_DIR_CLS,
  CHANGED_FILES_ROW_ICON_CLS,
  CHANGED_FILES_ROW_NAME_CLS,
  CHANGED_FILES_ROW_STAT_CLS,
  CHANGED_FILES_SEPARATOR_CLS,
  CHANGED_FILES_TOGGLE_CLS,
} from "../ui/composer-anatomy-recipes";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

export interface ChangedFilesBarProps {
  readonly summary: Pick<ThreadCheckpointSummary, "files" | "filesTotal">;
  readonly onReview: () => void;
  readonly onUndo?: (() => void) | undefined;
  readonly onKeep?: (() => void) | undefined;
  /** Blocks Undo all and Keep all (a turn is still writing, or a revert is running). Review stays. */
  readonly disabled?: boolean | undefined;
  /** A narrow composer: the count without the word, additions only, bulk actions in a menu. */
  readonly compact?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly onExpandedChange?: ((expanded: boolean) => void) | undefined;
}

function fileLabel(count: number): string {
  return `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;
}

/** The composer tab's changes: count and totals (they expand the list), Undo all, Keep all, Review. */
export const ChangedFilesBar = memo(function ChangedFilesBar({
  summary,
  onReview,
  onUndo,
  onKeep,
  disabled = false,
  compact = false,
  expanded = false,
  onExpandedChange,
}: ChangedFilesBarProps) {
  const totals = checkpointFileTotals(summary);
  if (totals.count === 0) return null;
  const label = `${fileLabel(totals.count)} changed`;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  const undoDisabled = disabled || onUndo === undefined;
  const keepDisabled = disabled || onKeep === undefined;
  return (
    <div
      data-changed-files-bar="true"
      data-compact={compact ? "" : undefined}
      className={CHANGED_FILES_BAR_CLS}
    >
      <button
        type="button"
        onClick={() => onExpandedChange?.(!expanded)}
        className={CHANGED_FILES_TOGGLE_CLS}
        aria-expanded={expanded}
        aria-label={expanded ? `Hide ${label}` : `Show ${label}`}
      >
        {compact ? null : <Chevron aria-hidden className={CHANGED_FILES_CHEVRON_CLS} />}
        <span>{compact ? totals.count.toLocaleString() : fileLabel(totals.count)}</span>
        {hasNonZeroStat(totals) ? (
          <DiffStatLabel
            additions={totals.additions}
            deletions={compact ? 0 : totals.deletions}
            layout="inline"
            className="text-xs"
          />
        ) : null}
      </button>
      {compact ? null : (
        <>
          <span aria-hidden className={CHANGED_FILES_SEPARATOR_CLS} />
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={onUndo}
            disabled={undoDisabled}
          >
            Undo all
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={onKeep}
            disabled={keepDisabled}
          >
            Keep all
          </Button>
        </>
      )}
      <Button type="button" size="xs" variant="default" onClick={onReview}>
        Review
      </Button>
      {compact ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="More change actions"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            <MenuItem disabled={undoDisabled} onClick={() => onUndo?.()}>
              Undo all
            </MenuItem>
            <MenuItem disabled={keepDisabled} onClick={() => onKeep?.()}>
              Keep all
            </MenuItem>
            <MenuItem onClick={() => onExpandedChange?.(!expanded)}>
              {expanded ? "Hide files" : "Show files"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
});

/** The turn's files, listed above the tab's row while the changes are expanded. */
export const ChangedFilesList = memo(function ChangedFilesList({
  summary,
  onReview,
}: Pick<ChangedFilesBarProps, "summary" | "onReview">) {
  return (
    <ul data-changed-files-list="true" className={CHANGED_FILES_LIST_CLS}>
      {summary.files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <li key={file.path}>
            <button
              type="button"
              onClick={onReview}
              className={CHANGED_FILES_ROW_CLS}
              aria-label={file.path}
            >
              <FileIcon aria-hidden className={CHANGED_FILES_ROW_ICON_CLS} />
              {slash >= 0 ? (
                <span className={CHANGED_FILES_ROW_DIR_CLS}>{file.path.slice(0, slash + 1)}</span>
              ) : null}
              <span className={CHANGED_FILES_ROW_NAME_CLS}>{file.path.slice(slash + 1)}</span>
              <span className={CHANGED_FILES_ROW_STAT_CLS}>
                <DiffStatLabel
                  additions={file.additions}
                  deletions={file.deletions}
                  layout="inline"
                  className="text-xs"
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});
