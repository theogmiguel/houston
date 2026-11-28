import { type EnvironmentId, type ThreadId, WS_METHODS } from "@houston-app/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@houston-app/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/** Sampled only while the thread details Memory row is mounted. */
export const threadMemory = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-memory",
  tag: WS_METHODS.houstonThreadMemorySubscribe,
});

export function useThreadMemory(environmentId: EnvironmentId, threadId: ThreadId) {
  return useEnvironmentQuery(threadMemory({ environmentId, input: { threadId } }));
}
