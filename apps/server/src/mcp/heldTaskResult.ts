import type { OrchestratorMcpDelegateTaskResult } from "@houston-app/contracts";

/**
 * A queued child only returns a `wait` call at once when it is held; a child merely waiting
 * behind other work must still be waited on.
 */
export function returnsHeldTaskAtOnce(
  result: Pick<OrchestratorMcpDelegateTaskResult, "status" | "queuedReason">,
): boolean {
  return result.status === "queued" && result.queuedReason !== undefined;
}
