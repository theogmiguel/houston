import { createSlackEnvironmentAtoms } from "@houston-app/client-runtime/state/slack";

import { connectionAtomRuntime } from "../connection/runtime";

export const slackEnvironment = createSlackEnvironmentAtoms(connectionAtomRuntime);
