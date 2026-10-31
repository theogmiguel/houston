// At startup, unassigns tasks whose project no longer exists: a deletion whose hook did not run,
// such as one interrupted between its commit and the hook, leaves them on a deleted project.
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonTaskStore } from "./TaskStore.ts";

export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonTaskStore;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const live = new Set((yield* projects.list()).map((project) => project.projectId as string));
  const assigned = yield* sql<{ readonly project_id: string }>`
    SELECT DISTINCT project_id FROM houston_tasks WHERE project_id IS NOT NULL
  `;
  for (const { project_id } of assigned) {
    if (!live.has(project_id)) yield* store.projectRemoved(project_id as ProjectId);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to unassign tasks of deleted projects.", cause),
  ),
);
