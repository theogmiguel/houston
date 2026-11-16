import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { findLayoutTab, type LayoutState } from "./layoutModel";

/** The thread a chat target shows: its own, or a draft's. Null once the draft's session is gone. */
export function chatTargetThreadRef(target: ThreadRouteTarget): ScopedThreadRef | null {
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId)) : null;
}

/**
 * The threads the tabs on screen show, for the sidebar: a server chat counts for its thread and a
 * surface tab counts for the thread it belongs to, as its chat would. A draft has no row yet.
 */
export function threadKeysOfTabs(
  layout: LayoutState,
  tabIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of tabIds) {
    const content = findLayoutTab(layout, (tab) => tab.id === id)?.tab.content;
    if (content?.kind === "surface") keys.add(scopedThreadKey(content.threadRef));
    else if (content?.kind === "chat" && content.target.kind === "server") {
      keys.add(scopedThreadKey(content.target.threadRef));
    }
  }
  return keys;
}
