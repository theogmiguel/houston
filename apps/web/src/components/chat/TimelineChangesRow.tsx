import type { OrchestrationV2CheckpointFileTotals } from "@houston-app/contracts";
import { useSyncLayout } from "@legendapp/list/react";
import { ChevronRightIcon, FileIcon, PencilIcon } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  TIMELINE_CHANGE_CHIP_CLS,
  TIMELINE_CHANGE_FOCUS_CLS,
  TIMELINE_CHANGE_ICON_CLS,
  TIMELINE_CHANGE_LABEL_CLS,
  TIMELINE_CHANGE_OVERFLOW_CLS,
  TIMELINE_CHANGE_ROW_CLS,
  TIMELINE_CHANGE_STAT_CLS,
  TIMELINE_CHANGE_TOGGLE_CLS,
} from "../ui/timeline-changes-recipes";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

export interface TimelineChangeFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** A file's path and stat as one openable chip. */
export function TimelineFileChip({
  file,
  workspaceRoot,
  onOpen,
  onContextMenu,
}: {
  readonly file: TimelineChangeFile;
  readonly workspaceRoot?: string | undefined;
  readonly onOpen: () => void;
  readonly onContextMenu?: ((event: ReactMouseEvent<HTMLButtonElement>) => void) | undefined;
}) {
  const label = formatWorkspaceRelativePath(file.path, workspaceRoot);
  return (
    <button
      type="button"
      aria-label={`Open diff for ${label}`}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className={TIMELINE_CHANGE_CHIP_CLS}
    >
      <FileIcon aria-hidden className={cn(TIMELINE_CHANGE_ICON_CLS, "text-(--houston)")} />
      <span className={TIMELINE_CHANGE_LABEL_CLS}>{label}</span>
      {hasNonZeroStat(file) ? (
        <DiffStatLabel
          additions={file.additions}
          deletions={file.deletions}
          layout="inline"
          className={TIMELINE_CHANGE_STAT_CLS}
        />
      ) : null}
    </button>
  );
}

/**
 * A turn's changes as one compact row: the file count and totals open the full diff, and each
 * changed file is a chip under it. The body collapses for long lists; `detail` keeps a card's
 * own inline diff under the chips.
 */
export function TimelineChangesRow({
  files,
  totals,
  workspaceRoot,
  onOpenDiff,
  onOpenFile,
  onFileContextMenu,
  detail,
  defaultExpanded = true,
}: {
  readonly files: ReadonlyArray<TimelineChangeFile>;
  readonly totals: Pick<OrchestrationV2CheckpointFileTotals, "count" | "additions" | "deletions">;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenDiff?: (() => void) | undefined;
  readonly onOpenFile: (path: string) => void;
  readonly onFileContextMenu?:
    | ((path: string, event: ReactMouseEvent<HTMLButtonElement>) => void)
    | undefined;
  readonly detail?: ReactNode;
  readonly defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const syncTimelineLayout = useSyncLayout();
  const toggleExpanded = () => {
    setExpanded((current) => !current);
    // Measure the new height before paint instead of waiting for LegendList's deferred pass.
    syncTimelineLayout();
  };
  const hiddenCount = Math.max(0, totals.count - files.length);
  const countLabel = `${totals.count.toLocaleString()} file${totals.count === 1 ? "" : "s"}`;
  const hasBody = files.length > 0 || detail !== undefined;

  return (
    <div data-timeline-changes="" className="min-w-0">
      <div className={TIMELINE_CHANGE_ROW_CLS}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${countLabel}` : `Expand ${countLabel}`}
          disabled={!hasBody}
          onClick={toggleExpanded}
          className={cn(TIMELINE_CHANGE_TOGGLE_CLS, TIMELINE_CHANGE_FOCUS_CLS)}
        >
          <PencilIcon aria-hidden className={cn(TIMELINE_CHANGE_ICON_CLS, "text-(--houston)")} />
          <span className="min-w-0 truncate text-(--t1)">{countLabel}</span>
          <DiffStatLabel
            additions={totals.additions}
            deletions={totals.deletions}
            layout="inline"
            className="shrink-0"
          />
        </button>
        {onOpenDiff === undefined ? null : (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="ms-auto shrink-0"
            aria-label="Open diff"
            onClick={onOpenDiff}
          >
            <ChevronRightIcon aria-hidden className="size-3" />
            <span>Open diff</span>
          </Button>
        )}
      </div>
      {expanded && hasBody ? (
        <div className="mt-1 flex flex-col gap-1">
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {files.map((file) => (
                <TimelineFileChip
                  key={file.path}
                  file={file}
                  workspaceRoot={workspaceRoot}
                  onOpen={() => onOpenFile(file.path)}
                  {...(onFileContextMenu === undefined
                    ? {}
                    : {
                        onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => {
                          event.preventDefault();
                          onFileContextMenu(file.path, event);
                        },
                      })}
                />
              ))}
              {hiddenCount > 0 && onOpenDiff !== undefined ? (
                <button
                  type="button"
                  onClick={onOpenDiff}
                  className={cn(TIMELINE_CHANGE_CHIP_CLS, TIMELINE_CHANGE_OVERFLOW_CLS)}
                >
                  +{hiddenCount.toLocaleString()} in the full diff
                </button>
              ) : null}
            </div>
          ) : null}
          {detail}
        </div>
      ) : null}
    </div>
  );
}
