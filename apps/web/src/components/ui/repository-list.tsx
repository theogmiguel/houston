import { ChevronRightIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "./button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  DISCLOSURE_CHEVRON_MOTION,
} from "./collapsible";
import { MiddleTruncate } from "./middle-truncate";
import { SelectTrigger } from "./select";
import { ThreadDetailsRowDiffCount } from "./thread-details-row";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2";

/**
 * One repository's changed files under a collapsible header. The name keeps its space; the
 * branch gives way first because the header still names the repository when it truncates.
 */
export function RepositoryChangesGroup({
  name,
  branch,
  additions,
  deletions,
  defaultExpanded = true,
  children,
}: {
  readonly name: string;
  readonly branch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly defaultExpanded?: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      data-repository-changes=""
      className="min-w-0"
    >
      <CollapsibleTrigger
        className={cn(
          "group flex h-8 w-full min-w-0 items-center gap-2 rounded-[var(--r-ctl)] px-2 text-left text-xs text-foreground hover:bg-hover",
          FOCUS_RING,
        )}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            DISCLOSURE_CHEVRON_MOTION,
            "size-3 shrink-0 text-muted-foreground group-data-panel-open:rotate-90",
          )}
        />
        <span className="min-w-0 max-w-full shrink-0 truncate font-medium">{name}</span>
        <span className="flex min-w-0 flex-1 font-mono text-muted-foreground">
          <MiddleTruncate value={branch} className="max-w-full" />
        </span>
        <DiffStatLabel
          additions={additions}
          deletions={deletions}
          layout="inline"
          className="shrink-0 text-xs"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <div className="pb-1">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The unreadable repository's row, kept in its group position with the action that can recover. */
export function RepositoryChangesErrorRow({
  message,
  retrying = false,
  onRetry,
}: {
  readonly message: string;
  readonly retrying?: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2 px-2 text-xs">
      <span className="min-w-0 flex-1 text-error">{message}</span>
      <Button type="button" size="xs" variant="ghost-muted" disabled={retrying} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** The diff panel's repository picker trigger, sized to its name rather than the row. */
export function RepositorySelectTrigger({
  className,
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      {...props}
      size="xs"
      className={cn("w-auto min-w-0 max-w-48 shrink-0", className)}
    />
  );
}

/** A centered, inline explanation where a repository choice is still required. */
export function RepositoryChoiceNotice({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

/** The message a multi-repository changes list shows when no repository has changes. */
export function RepositoryChangesEmptyMessage() {
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground/70 group-has-[[data-repository-changes]]/repository-changes:hidden group-has-[[data-repository-loading]]/repository-changes:hidden">
      No changes in any repository.
    </p>
  );
}

/** A repository's changes could not be read, shown under its group. */
export function RepositoryChangesInlineError({ children }: { readonly children: ReactNode }) {
  return <p className="px-2 text-2xs text-error">{children}</p>;
}

/** One repository in the thread details' git-actions list. */
export function RepositorySelectionRow({
  name,
  branch,
  insertions,
  deletions,
  selected,
  errorMessage,
  onSelect,
}: {
  readonly name: string;
  readonly branch: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly selected: boolean;
  readonly errorMessage?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "grid min-h-7 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--r-ctl)] px-2 py-0.5 text-left text-xs",
        selected ? "bg-selected text-foreground" : "text-secondary-foreground hover:bg-hover",
        FOCUS_RING,
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 max-w-full shrink-0 truncate font-medium text-foreground">
            {name}
          </span>
          {errorMessage === undefined ? (
            <span className="flex min-w-0 flex-1 font-mono text-muted-foreground">
              <MiddleTruncate value={branch} className="max-w-full" />
            </span>
          ) : null}
        </span>
        {errorMessage === undefined ? null : (
          <span className="whitespace-normal text-2xs text-error">{errorMessage}</span>
        )}
      </span>
      {errorMessage === undefined ? (
        <ThreadDetailsRowDiffCount insertions={insertions} deletions={deletions} />
      ) : null}
    </button>
  );
}
