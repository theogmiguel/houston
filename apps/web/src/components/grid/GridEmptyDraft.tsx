import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import type { CSSProperties, RefObject } from "react";

import { useGridStore, type GridRecord } from "../../grid/gridStore";
import { openGridDraft } from "../../grid/newThreadDraft";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { ThreadDraftSurface, useOpenedDraft } from "../chat/ThreadDraftSurface";

/** An empty grid's composer: the draft has no pane head and no timeline. */
export function GridEmptyDraft({
  grid,
  threadDetailsAnchor,
  onDraftChange,
}: {
  grid: GridRecord;
  /** Anchors the draft's popover details card under the top bar control. */
  threadDetailsAnchor?: RefObject<Element | null>;
  onDraftChange?: (draft: { threadId: ThreadId } | null) => void;
}) {
  const handleNewThread = useNewThreadHandler();
  const draft = useOpenedDraft({
    open: () =>
      openGridDraft({ gridId: grid.id, focusedThreadId: grid.focusedThreadId }, handleNewThread),
    onPromoted: (threadId) => useGridStore.getState().addThread(grid.id, threadId),
    onChange: onDraftChange,
  });

  if (draft === null) {
    return null;
  }

  return (
    <div
      data-grid-empty-draft
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--chat-content-max-width": "760px" } as CSSProperties}
    >
      <ThreadDraftSurface
        environmentId={grid.environmentId as EnvironmentId}
        draft={draft}
        threadDetailsAnchor={threadDetailsAnchor}
      />
    </div>
  );
}
