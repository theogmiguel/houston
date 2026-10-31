import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import ChatView from "../ChatView";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useGridStore, type GridRecord } from "../../grid/gridStore";
import { openGridDraft } from "../../grid/newThreadDraft";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useStableCallback } from "../../hooks/useStableCallback";

interface EmptyDraftState {
  draftId: DraftId;
  threadId: ThreadId;
}

/** An empty grid's composer: the draft has no pane head and no timeline. */
export function GridEmptyDraft({ grid }: { grid: GridRecord }) {
  const handleNewThread = useNewThreadHandler();
  const createDraft = useStableCallback(handleNewThread);
  const [draft, setDraft] = useState<EmptyDraftState | null>(null);
  const requestedRef = useRef(false);
  const promotedRef = useRef(false);
  const session = useComposerDraftStore((store) =>
    draft === null ? null : store.getDraftSession(draft.draftId),
  );
  const promoted = useComposerDraftStore((store) =>
    draft === null ? null : store.getPromotedDraftRedirect(draft.draftId),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the empty grid's draft once when the grid mounts
  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void openGridDraft(
      { gridId: grid.id, focusedThreadId: grid.focusedThreadId },
      createDraft,
    ).then((opened) => {
      if (opened !== null) {
        setDraft({ draftId: opened.draftId, threadId: opened.threadId });
      }
    });
  }, [grid.id, grid.focusedThreadId, createDraft]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves a promoted empty-grid draft into the grid store
  useEffect(() => {
    if (draft === null || session !== null || promoted === null || promotedRef.current) return;
    promotedRef.current = true;
    useGridStore.getState().addThread(grid.id, promoted.threadId);
  }, [draft, grid.id, promoted, session]);

  if (draft === null) {
    return null;
  }

  return (
    <div
      data-grid-empty-draft
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--chat-content-max-width": "760px" } as CSSProperties}
    >
      <ChatView
        embedded
        centerDraftComposer
        hideDraftHeroHeadline
        environmentId={grid.environmentId as EnvironmentId}
        threadId={draft.threadId}
        routeKind="draft"
        draftId={draft.draftId}
      />
    </div>
  );
}
