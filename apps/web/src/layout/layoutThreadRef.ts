import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";

/** The thread a chat target shows: its own, or a draft's. Null once the draft's session is gone. */
export function chatTargetThreadRef(target: ThreadRouteTarget): ScopedThreadRef | null {
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId)) : null;
}
