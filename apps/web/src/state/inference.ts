import { WS_METHODS } from "@houston-app/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const INFERENCE_SERVERS_EMPTY_INPUT = {} as const;
export const INFERENCE_DISCOVERY_EMPTY_INPUT = {} as const;

/** The server's current snapshots, pushed whenever a probe or a settings change lands. */
export const inferenceServers = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:servers",
  tag: WS_METHODS.houstonInferenceSubscribe,
});

export const refreshInferenceServers = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inference:refresh",
  tag: WS_METHODS.houstonInferenceRefresh,
});

export const saveInferenceServer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inference:save",
  tag: WS_METHODS.houstonInferenceSave,
});

export const removeInferenceServer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inference:remove",
  tag: WS_METHODS.houstonInferenceRemove,
});

export const discoverInferenceServers = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:discover",
  tag: WS_METHODS.houstonInferenceDiscover,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
