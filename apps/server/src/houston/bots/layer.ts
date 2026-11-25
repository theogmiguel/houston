// The bots: their store, their requests, and the startup sweep of deleted projects.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Service from "./Service.ts";
import * as Store from "./Store.ts";

/** At startup, takes projects deleted since off the bots that list them. */
const sweep = Effect.gen(function* () {
  const store = yield* Store.HoustonBotStore;
  if (!(yield* store.isOn)) return;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const live = new Set<string>(
    (yield* projects.list())
      .filter((project) => project.deletedAt === null)
      .map((project) => project.projectId),
  );
  yield* store.dropProjects((projectId) => live.has(projectId));
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to take deleted projects off the bots.", cause),
  ),
);

export const layerBots = Layer.mergeAll(Service.layer, Layer.effectDiscard(sweep)).pipe(
  Layer.provideMerge(Store.layer),
);
