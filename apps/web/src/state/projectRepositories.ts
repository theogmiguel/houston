import { WS_METHODS, type EnvironmentId, type ProjectId } from "@houston-app/contracts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@houston-app/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-repositories:list",
  tag: WS_METHODS.houstonProjectsRepositoriesList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

function refreshAfter(
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly projectId: ProjectId };
  },
  registry: AtomRegistry.AtomRegistry,
) {
  return Effect.sync(() =>
    registry.refresh(
      list({ environmentId: target.environmentId, input: { projectId: target.input.projectId } }),
    ),
  );
}

const serialPerEnvironment = {
  mode: "serial" as const,
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
};

/**
 * The repositories one project covers: discovery and tracked folders read together, and the
 * three mutations that each answer with the new list, which is then refetched for every reader.
 */
export const projectRepositories = {
  list,
  track: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:project-repositories:track",
    tag: WS_METHODS.houstonProjectsRepositoriesTrack,
    scheduler,
    concurrency: serialPerEnvironment,
    onSettled: refreshAfter,
  }),
  untrack: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:project-repositories:untrack",
    tag: WS_METHODS.houstonProjectsRepositoriesUntrack,
    scheduler,
    concurrency: serialPerEnvironment,
    onSettled: refreshAfter,
  }),
  setIgnorePatterns: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:project-repositories:ignore",
    tag: WS_METHODS.houstonProjectsRepositoriesIgnore,
    scheduler,
    concurrency: serialPerEnvironment,
    onSettled: refreshAfter,
  }),
};
