// At startup, drops the tracked folders and ignore patterns of projects that no longer exist: a
// deletion whose hook did not run, such as one interrupted between its commit and the hook.
import type { ProjectId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { HoustonProjectRepositoriesStore } from "./ProjectRepositoriesStore.ts";

export const sweep = Effect.gen(function* () {
  const store = yield* HoustonProjectRepositoriesStore;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const live = new Set(
    (yield* projects.list())
      .filter((project) => project.deletedAt === null)
      .map((project) => project.projectId as string),
  );
  for (const projectId of yield* store.projectIds) {
    if (!live.has(projectId)) yield* store.projectRemoved(projectId as ProjectId);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to drop the repositories of deleted projects.", cause),
  ),
);
