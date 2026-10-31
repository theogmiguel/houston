import { type OrchestrationV2TurnItem } from "@t3tools/contracts";

type SubagentStatus = OrchestrationV2TurnItem["status"];

export function isSubagentRunning(status: SubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function subagentGroupSummaryText(statuses: ReadonlyArray<SubagentStatus>) {
  const count = statuses.length;
  const running = statuses.filter(isSubagentRunning).length;
  return {
    label: `Started ${count} ${count === 1 ? "subagent" : "subagents"}`,
    running: running > 0 ? `${running} running` : null,
  };
}

export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "completed":
      return "Ready";
    case "running":
    case "waiting":
    case "pending":
      return "Running";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}
