import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import ChatView from "../ChatView";

export interface OpenedDraft {
  readonly draftId: DraftId;
  readonly threadId: ThreadId;
}

/**
 * Opens one draft when the surface mounts and reports when the draft is promoted to a thread.
 * `open` runs once; `onPromoted` runs once, with the thread the draft became.
 */
export function useOpenedDraft({
  open,
  onPromoted,
  onChange,
}: {
  readonly open: () => Promise<OpenedDraft | null>;
  readonly onPromoted: (threadId: ThreadId) => void;
  readonly onChange?: ((draft: { threadId: ThreadId } | null) => void) | undefined;
}): OpenedDraft | null {
  const openDraft = useStableCallback(open);
  const notifyPromoted = useStableCallback(onPromoted);
  const notifyChange = useStableCallback(onChange ?? (() => {}));
  const [draft, setDraft] = useState<OpenedDraft | null>(null);
  const requestedRef = useRef(false);
  const promotedRef = useRef(false);
  const session = useComposerDraftStore((store) =>
    draft === null ? null : store.getDraftSession(draft.draftId),
  );
  const promoted = useComposerDraftStore((store) =>
    draft === null ? null : store.getPromotedDraftRedirect(draft.draftId),
  );

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- creates the surface's draft once when it mounts
  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    void openDraft().then((opened) => {
      if (opened !== null) {
        setDraft({ draftId: opened.draftId, threadId: opened.threadId });
        notifyChange({ threadId: opened.threadId });
      }
    });
    return () => notifyChange(null);
  }, [openDraft, notifyChange]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- hands a promoted draft's thread to the host once
  useEffect(() => {
    if (draft === null || session !== null || promoted === null || promotedRef.current) return;
    promotedRef.current = true;
    notifyPromoted(promoted.threadId);
  }, [draft, notifyPromoted, promoted, session]);

  return draft;
}

/** A draft's composer on its own: no pane head, no timeline, the composer centred. */
export function ThreadDraftSurface({
  environmentId,
  draft,
  threadDetailsAnchor,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: OpenedDraft;
  /** Anchors the draft's popover details card under a host control. */
  readonly threadDetailsAnchor?: RefObject<Element | null> | undefined;
}) {
  return (
    <ChatView
      embedded
      centerDraftComposer
      hideDraftHeroHeadline
      environmentId={environmentId}
      threadId={draft.threadId}
      routeKind="draft"
      draftId={draft.draftId}
      {...(threadDetailsAnchor ? { detailsCardAnchor: threadDetailsAnchor } : {})}
    />
  );
}
