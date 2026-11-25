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

/** Asks one model to name test images; the server records reads-images or text-only. */
export const checkInferenceModelImages = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inference:check-images",
  tag: WS_METHODS.houstonInferenceCheckImages,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input.serverId, input.model]),
  },
});

export const discoverInferenceServers = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:discover",
  tag: WS_METHODS.houstonInferenceDiscover,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

/** Gateway usage for one window; mounted only while the Usage page's Local compute section shows. */
export const inferenceUsage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:usage",
  tag: WS_METHODS.houstonInferenceUsage,
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
});

/** The thread's latest gateway request, read when thread details open. */
export const threadInferenceRequest = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:thread-request",
  tag: WS_METHODS.houstonInferenceThreadRequest,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});

/** The latest reply Houston's gateway stopped in a thread, read when a run settles. */
export const threadInferenceStop = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:inference:thread-stop",
  tag: WS_METHODS.houstonInferenceThreadStop,
  staleTimeMs: 0,
  idleTtlMs: 60_000,
});
