// The merge queue's note to an owner thread (AD-061): one queued user message per id, which
// waits behind an active run and starts a turn on an idle thread. The orchestrator applies it.
import type { OrchestrationV2Command, OrchestrationV2Run } from "@t3tools/contracts";

export const MERGE_QUEUE_NOTE_ALREADY_SENT = "This merge queue note is already in the thread.";
export const MERGE_QUEUE_NOTE_NEEDS_LIVE_THREAD =
  "A merge queue note goes only to a thread that is not archived.";

const ACTIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Queued behind an active run, never steering or interrupting it; started on an idle thread. */
export const noteDispatchMode = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>["dispatchMode"] =>
  runs.some((run) => ACTIVE.has(run.status))
    ? { type: "queue_after_active" }
    : { type: "start_immediately" };
