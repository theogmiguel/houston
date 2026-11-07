import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { FolderIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ThreadRowPullRequestBadge } from "../grid/ThreadRowPullRequestBadge";
import type { RowPullRequest } from "~/grid/sidebar";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { GridPaneRenameInput } from "./grid-pane";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { PANE_THREAD_TAG_CLASS, PANE_THREAD_TAG_COUNT_CLASS } from "./thread-tag-recipes";

/**
 * A grid pane's header bar: the thread's status, project and title, its pull request, and the
 * pane actions. It sits on the pane surface, so the conversation scrolls beneath it rather than
 * behind a floating label.
 */
export function GridPaneHeader(props: {
  projectTitle: string | null;
  title: string;
  status: ReactNode;
  providerStack: ReactNode;
  tags: ReadonlyArray<string>;
  pullRequest: RowPullRequest | null;
  pullRequestCount: number;
  threadRef: ScopedThreadRef;
  /** The measured pane width; the project and PR collapse as it narrows. */
  width: number;
  focused: boolean;
  /** The thread's attention colour, drawn as the pane's top edge. */
  attentionColor: string | null;
  renaming: boolean;
  renameValue: string;
  onChangeRename: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDoubleClickTitle: (() => void) | undefined;
  onDragHandlePointerDown: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  actions: ReactNode;
}) {
  // A narrow pane keeps the project as its icon and the pull request as its mark.
  const projectIsIcon = props.width > 0 && props.width < 420;
  const pullRequestIsIcon = props.width > 0 && props.width < 380;
  return (
    <div
      data-pane-header=""
      data-pane-label=""
      onPointerDown={props.onDragHandlePointerDown}
      style={{
        ...(props.onDragHandlePointerDown === undefined ? {} : { cursor: "grab" }),
        ...(props.attentionColor === null ? {} : { borderTopColor: props.attentionColor }),
      }}
      className={cn(
        "relative z-20 flex h-9 shrink-0 items-center gap-1.5 border-t-2 border-b border-b-(--divider) bg-(--pane-head) ps-2.5",
        props.attentionColor === null && "border-t-transparent",
        !props.focused && "opacity-90",
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        {props.status}
        {props.providerStack}
      </span>
      {props.projectTitle === null ? null : (
        <span
          data-thread-project=""
          className="flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground text-xs"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={props.projectTitle}
                  data-pane-project-mark=""
                  className="flex max-w-40 min-w-0 items-center gap-1 truncate"
                />
              }
            >
              <FolderIcon aria-hidden className="size-3 shrink-0" />
              <span className={cn("min-w-0 truncate", projectIsIcon && "sr-only")}>
                {props.projectTitle}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{props.projectTitle}</TooltipPopup>
          </Tooltip>
          <span aria-hidden className={cn("shrink-0 text-icon-muted", projectIsIcon && "hidden")}>
            /
          </span>
        </span>
      )}
      {props.renaming ? (
        <GridPaneRenameInput
          value={props.renameValue}
          onChange={props.onChangeRename}
          onCommit={props.onCommitRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span
          onDoubleClick={props.onDoubleClickTitle}
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-4 font-medium",
            props.focused ? "text-(--t1)" : "text-(--t2)",
          )}
        >
          {props.title}
        </span>
      )}
      {props.tags.length > 0 ? (
        <span
          data-pane-tags=""
          className="flex shrink-0 items-center gap-1 @max-[420px]/pane:hidden"
        >
          {props.tags.slice(0, 2).map((tag) => (
            <span key={tag} className={PANE_THREAD_TAG_CLASS}>
              {tag}
            </span>
          ))}
          {props.tags.length > 2 ? (
            <span className={PANE_THREAD_TAG_COUNT_CLASS}>+{props.tags.length - 2}</span>
          ) : null}
        </span>
      ) : null}
      {props.pullRequest === null ? null : (
        <span className={cn("shrink-0", pullRequestIsIcon && "[&_span]:hidden")}>
          <ThreadRowPullRequestBadge
            threadRef={props.threadRef}
            pullRequest={props.pullRequest}
            pullRequestCount={props.pullRequestCount}
            onOpenThread={() => {}}
          />
        </span>
      )}
      <div
        data-pane-actions=""
        className="absolute inset-y-0 end-1 z-10 flex items-center gap-0.5 bg-(--pane-head) ps-1 opacity-0 transition-opacity duration-(--motion-feedback) ease-standard group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 motion-reduce:transition-none"
      >
        {props.actions}
      </div>
    </div>
  );
}
