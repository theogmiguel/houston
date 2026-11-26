import { createEnvironmentRpcQueryAtomFamily } from "@houston-app/client-runtime/state/runtime";
import { WS_METHODS } from "@houston-app/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** The repositories one project covers, with each one's branch or why it could not be read. */
export const projectRepositories = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-repositories:list",
  tag: WS_METHODS.houstonProjectsRepositoriesList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
