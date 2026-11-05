import type { AddProjectRemoteSource } from "@houston-app/client-runtime/operations/projects";
import type { EnvironmentId } from "@houston-app/contracts";

export type AddProjectAction = "open-folder" | "clone" | "new-project";

/** The flow the Add project dialog starts, and where it starts it. */
export interface AddProjectFlowRequest {
  readonly action: AddProjectAction;
  readonly environmentId?: EnvironmentId;
  readonly source?: AddProjectRemoteSource;
}
