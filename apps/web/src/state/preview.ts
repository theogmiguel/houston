import { createPreviewEnvironmentAtoms } from "@houston-app/client-runtime/state/preview";

import { connectionAtomRuntime } from "../connection/runtime";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
