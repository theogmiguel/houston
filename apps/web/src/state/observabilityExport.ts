import { WS_METHODS } from "@houston-app/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const DATADOG_KEY_EMPTY_INPUT = {} as const;

/** Whether the server stores a Datadog API key; the key itself never reaches the client. */
export const datadogKeyStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:observability:datadog-key-status",
  tag: WS_METHODS.houstonObservabilityGetDatadogKeyStatus,
  staleTimeMs: 0,
  idleTtlMs: 30_000,
});

export const setDatadogKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:observability:datadog-key-set",
  tag: WS_METHODS.houstonObservabilitySetDatadogKey,
});

export const clearDatadogKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:observability:datadog-key-clear",
  tag: WS_METHODS.houstonObservabilityClearDatadogKey,
});
