import { createTaskSourceEnvironmentAtoms } from "@houston-app/client-runtime/state/taskSources";

import { connectionAtomRuntime } from "../connection/runtime";

export const taskSourcesEnvironment = createTaskSourceEnvironmentAtoms(connectionAtomRuntime);
