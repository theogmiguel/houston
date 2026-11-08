import { CheckIcon, ChevronDownIcon, ChevronUpIcon, FileText, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";

export interface DiffFileListEntry {
  readonly path: string;
  /** Absent while the file's patch is still loading: the stats alone cannot tell added from modified. */
  readonly status?: string | undefined;
  readonly additions: number;
  readonly deletions: number;
}

export interface DiffFileListState {
  readonly viewed?: "viewed" | "dismissed" | undefined;
  readonly stage?: "stage" | "unstage" | null;
}

const DIFF_STATUS_LETTERS: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M",
};

export function FileViewedMark({
  viewed,
}: {
  readonly viewed?: "viewed" | "dismissed" | undefined;
}) {
  if (viewed === "viewed") {
    return <CheckIcon aria-label="Viewed" className="size-3 shrink-0 text-diff-addition" />;
  }
  if (viewed === "dismissed") {
    return (
      <span
        aria-label="Changed since viewed"
        className="size-1.5 shrink-0 rounded-full bg-warning"
      />
    );
  }
  return null;
}

export function DiffFileList(props: {
  readonly entries: ReadonlyArray<DiffFileListEntry>;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly fileState?: (path: string) => DiffFileListState;
  readonly onStageToggle?: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-px px-1.5 py-1.5">
      {props.entries.map((entry) => {
        const selected = entry.path === props.selectedPath;
        const state = props.fileState?.(entry.path);
        return (
          <div
            key={entry.path}
            className={cn(
              "flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-xs",
              selected ? "bg-selected text-foreground" : "text-secondary-foreground hover:bg-hover",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectFile(entry.path)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            >
              <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {entry.path.slice(
                  Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\")) + 1,
                )}
              </span>
              <FileViewedMark viewed={state?.viewed} />
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-addition">+{entry.additions}</span>{" "}
                <span className="text-diff-deletion">−{entry.deletions}</span>
              </span>
              <span className="w-3 shrink-0 text-center font-mono text-2xs text-muted-foreground">
                {entry.status === undefined ? "" : (DIFF_STATUS_LETTERS[entry.status] ?? "M")}
              </span>
            </button>
            {props.onStageToggle !== undefined && state?.stage != null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                aria-label={
                  state.stage === "unstage" ? `Unstage ${entry.path}` : `Stage ${entry.path}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  props.onStageToggle?.(entry.path);
                }}
              >
                {state.stage === "unstage" ? "Unstage" : "Stage"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function WorkingTreeGroupBar(props: {
  readonly unstagedCount: number;
  readonly stagedCount: number;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-pane-head px-2 py-1 text-2xs text-muted-foreground">
      <span>
        {props.unstagedCount} unstaged · {props.stagedCount} staged
      </span>
      <span className="flex gap-1">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={props.unstagedCount === 0}
          onClick={props.onStageAll}
        >
          Stage all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={props.stagedCount === 0}
          onClick={props.onUnstageAll}
        >
          Unstage all
        </Button>
      </span>
    </div>
  );
}

export function WorkingTreeFileActions(props: {
  readonly filePath: string;
  readonly viewed: boolean;
  readonly stageAction: "stage" | "unstage" | null;
  readonly discardLabel: string;
  readonly onViewedChange: (viewed: boolean) => void;
  readonly onStageToggle: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <>
      <label className="flex shrink-0 cursor-pointer items-center gap-1 text-2xs text-muted-foreground">
        <Checkbox
          aria-label={`Mark ${props.filePath} viewed`}
          checked={props.viewed}
          onCheckedChange={(checked) => props.onViewedChange(checked === true)}
        />
        Viewed
      </label>
      {props.stageAction !== null ? (
        <Button type="button" size="xs" variant="ghost-muted" onClick={props.onStageToggle}>
          {props.stageAction === "unstage" ? "Unstage" : "Stage"}
        </Button>
      ) : null}
      <Button type="button" size="xs" variant="ghost-destructive" onClick={props.onDiscard}>
        {props.discardLabel}
      </Button>
    </>
  );
}

export function PausedOperationBanner(props: {
  readonly operation: {
    readonly kind: "merge" | "rebase" | "cherry-pick";
    readonly conflictedPaths: ReadonlyArray<string>;
  };
  readonly onResolveWithAgent?: (() => void) | undefined;
}) {
  const finish =
    props.operation.kind === "merge"
      ? "Resolve the conflicts, stage the files, then commit to finish. To stop, run git merge --abort."
      : props.operation.kind === "rebase"
        ? "Resolve the conflicts, stage the files, then run git rebase --continue. To stop, run git rebase --abort."
        : "Resolve the conflicts, stage the files, then run git cherry-pick --continue. To stop, run git cherry-pick --abort.";
  return (
    <div
      role="status"
      className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs"
    >
      <p className="font-medium text-foreground">
        {props.operation.kind === "merge"
          ? "A merge is paused in this checkout."
          : props.operation.kind === "rebase"
            ? "A rebase is paused in this checkout."
            : "A cherry-pick is paused in this checkout."}
      </p>
      {props.operation.conflictedPaths.length > 0 ? (
        <p className="mt-0.5 text-muted-foreground">
          Conflicted files: {props.operation.conflictedPaths.join(", ")}
        </p>
      ) : null}
      <p className="mt-0.5 text-muted-foreground">{finish}</p>
      {props.onResolveWithAgent !== undefined ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="mt-1"
          onClick={props.onResolveWithAgent}
        >
          Resolve with agent
        </Button>
      ) : null}
    </div>
  );
}

export function DiffFindBar(props: {
  readonly query: string;
  readonly matchCase: boolean;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly partial: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onMatchCaseChange: (value: boolean) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}) {
  const count =
    props.query.length === 0
      ? ""
      : props.matchCount === 0
        ? "No matches"
        : `${props.activeIndex + 1} of ${props.matchCount}${props.partial ? " (partial)" : ""}`;
  return (
    <div
      data-diff-find
      className="flex shrink-0 items-center gap-1 border-b border-border bg-pane-head px-2 py-1"
    >
      <Input
        autoFocus
        size="compact"
        value={props.query}
        aria-label="Find in diff"
        placeholder="Find in diff"
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) props.onPrevious();
            else props.onNext();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <span className="shrink-0 px-1 text-2xs text-muted-foreground">{count}</span>
      <Button
        type="button"
        size="xs"
        variant={props.matchCase ? "secondary" : "ghost-muted"}
        aria-label="Match case"
        aria-pressed={props.matchCase}
        onClick={() => props.onMatchCaseChange(!props.matchCase)}
      >
        Aa
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Previous match"
        disabled={props.matchCount === 0}
        onClick={props.onPrevious}
      >
        <ChevronUpIcon aria-hidden className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Next match"
        disabled={props.matchCount === 0}
        onClick={props.onNext}
      >
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <XIcon aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

export function DiffFileFilter(props: {
  readonly value: string;
  readonly resultCount: number;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-pane-head px-2 py-1">
      <Input
        autoFocus
        size="compact"
        value={props.value}
        aria-label="Filter files"
        placeholder="Filter files"
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <span className="shrink-0 text-2xs text-muted-foreground">
        {props.resultCount} {props.resultCount === 1 ? "file" : "files"}
      </span>
    </div>
  );
}
