import { WS_METHODS } from "@houston-app/contracts";
import { createEnvironmentRpcCommand } from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

// One flow per server: a second click joins the first instead of starting another.
const concurrentPerServer = {
  mode: "singleFlight" as const,
  key: ({ environmentId, input }: { environmentId: string; input: { server: string } }) =>
    JSON.stringify([environmentId, input.server]),
};

export const startMcpSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-sign-in:start",
  tag: WS_METHODS.houstonMcpSignInStart,
  concurrency: concurrentPerServer,
});

export const completeMcpSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:mcp-sign-in:complete",
  tag: WS_METHODS.houstonMcpSignInComplete,
  concurrency: concurrentPerServer,
});
