import { type OrchestrationV2TurnItem } from "@houston-app/contracts";

type SubagentStatus = OrchestrationV2TurnItem["status"];

export function isSubagentRunning(status: SubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

const GROUP_STATES = ["working", "done", "failed", "stopped", "idle"] as const;

function groupState(status: SubagentStatus): (typeof GROUP_STATES)[number] {
  if (isSubagentRunning(status)) return "working";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "idle") return "idle";
  return "stopped";
}

/** The group card's heading: how many subagents, and how many are in each state. */
export function subagentGroupSummary(statuses: ReadonlyArray<SubagentStatus>) {
  const counts = new Map<(typeof GROUP_STATES)[number], number>();
  for (const status of statuses) {
    const state = groupState(status);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const tone: "active" | "failed" | "settled" = counts.has("working")
    ? "active"
    : counts.has("failed")
      ? "failed"
      : "settled";
  return {
    title: `${statuses.length} ${statuses.length === 1 ? "subagent" : "subagents"}`,
    status: GROUP_STATES.flatMap((state) =>
      counts.has(state) ? [`${counts.get(state)} ${state}`] : [],
    ).join(", "),
    tone,
  };
}

interface SubagentTiming {
  readonly status: SubagentStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** One clock for the group: from the first start, until the last agent finishes. */
export function subagentGroupTiming(agents: ReadonlyArray<SubagentTiming>): SubagentTiming {
  const live = agents.find(({ status }) => isSubagentRunning(status));
  const starts = agents.flatMap(({ startedAt }) => (startedAt === null ? [] : [startedAt]));
  const ends = agents.flatMap(({ completedAt }) => (completedAt === null ? [] : [completedAt]));
  const earliest = (values: ReadonlyArray<string>) =>
    values.reduce<string | null>(
      (first, value) => (first === null || Date.parse(value) < Date.parse(first) ? value : first),
      null,
    );
  const latest = (values: ReadonlyArray<string>) =>
    values.reduce<string | null>(
      (last, value) => (last === null || Date.parse(value) > Date.parse(last) ? value : last),
      null,
    );
  return {
    status: live?.status ?? "completed",
    startedAt: earliest(starts),
    completedAt: live === undefined && ends.length === agents.length ? latest(ends) : null,
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
