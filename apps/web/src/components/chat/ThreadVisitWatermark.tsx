import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import {
  createThreadVisitTracker,
  IDLE_THREAD_VISIT_TRACKER,
} from "@houston-app/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@houston-app/contracts";
import { useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: {
  readonly threadRef: ScopedThreadRef;
  /** The focused cell, or the only view on the standalone route. */
  readonly active?: boolean;
  /** The timeline is scrolled to its end; a reader scrolled up is not looking at new output. */
  readonly atEnd?: boolean;
}) {
  const activity = useSyncExternalStore(
    subscribeDocumentActivity,
    getDocumentActivity,
    getDocumentActivity,
  );
  const viewing =
    props.active !== false && props.atEnd !== false && activity.visible && activity.focused;
  useAtomMount(viewing ? threadVisitTracker(props.threadRef) : IDLE_THREAD_VISIT_TRACKER);
  return null;
}
