import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { GridPaneRenameInput } from "./grid-pane";

/**
 * A grid pane's header bar: the thread's status, title and the pane actions.
 * It sits on the pane surface, so the conversation scrolls beneath it rather than behind a
 * floating label.
 */
export function GridPaneHeader(props: {
  title: string;
  status: ReactNode;
  focused: boolean;
  renaming: boolean;
  renameValue: string;
  onChangeRename: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDoubleClickTitle: (() => void) | undefined;
  onDragHandlePointerDown: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
  actions: ReactNode;
}) {
  return (
    <div
      data-pane-header=""
      data-pane-label=""
      onPointerDown={props.onDragHandlePointerDown}
      style={props.onDragHandlePointerDown === undefined ? undefined : { cursor: "grab" }}
      className={cn(
        "relative z-20 flex h-9 shrink-0 items-center gap-1.5 border-b border-b-(--divider) bg-(--pane-head) px-2.5",
        !props.focused && "opacity-90",
      )}
    >
      {props.status === null ? null : (
        <span className="flex shrink-0 items-center">{props.status}</span>
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
            "min-w-0 flex-1 truncate text-xs leading-4",
            props.focused ? "font-semibold text-(--t1)" : "font-medium text-(--t2)",
          )}
        >
          {props.title}
        </span>
      )}
      <div
        data-pane-actions=""
        className={cn(
          "absolute inset-y-0 end-1 z-10 flex items-center gap-0.5 bg-(--pane-head) ps-1 opacity-0 transition-opacity duration-(--motion-feedback) ease-standard group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 motion-reduce:transition-none",
          props.focused && "opacity-100",
        )}
      >
        {props.actions}
      </div>
    </div>
  );
}
