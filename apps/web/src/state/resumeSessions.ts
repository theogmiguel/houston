import { WS_METHODS } from "@houston-app/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const houstonResumeSessions = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:houston-resume:sessions",
  tag: WS_METHODS.houstonResumeSessionsList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const houstonOpenResumeSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:houston-resume:open",
  tag: WS_METHODS.houstonResumeSessionOpen,
});
