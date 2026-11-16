import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";

/** The Tasks page reuses the thread right panel under a fixed, non-thread key. */
export const TASKS_PANEL_REF = scopeThreadRef(
  EnvironmentId.make("tasks-panel"),
  ThreadId.make("tasks-panel"),
);
