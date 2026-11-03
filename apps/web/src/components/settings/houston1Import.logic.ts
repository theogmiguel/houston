import type { HoustonSlackImportStatus } from "@houston-app/contracts/houston/slack";
import type { HoustonTaskSourceImportStatus } from "@houston-app/contracts/houston/taskSources";
import type { HoustonTaskImportStatus } from "@houston-app/contracts/houston/tasks";

export type Houston1ImportStep = "tasks" | "taskSources" | "slack";

export interface Houston1ImportStatuses {
  readonly tasks: HoustonTaskImportStatus | null;
  readonly taskSources: HoustonTaskSourceImportStatus | null;
  readonly slack: HoustonSlackImportStatus | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The imports that have something to copy; a blocked or finished one is not retried. */
export function houston1ImportSteps(statuses: Houston1ImportStatuses): Houston1ImportStep[] {
  const steps: Houston1ImportStep[] = [];
  if (statuses.tasks?.state === "available") steps.push("tasks");
  if (statuses.taskSources?.state === "available") steps.push("taskSources");
  if (statuses.slack?.state === "available") steps.push("slack");
  return steps;
}

/** The section appears while Houston 1 data remains, or after one of the imports ran. */
export function houston1ImportVisible(statuses: Houston1ImportStatuses): boolean {
  const states = [statuses.tasks, statuses.taskSources, statuses.slack];
  return states.some(
    (status) =>
      status !== null &&
      (status.state === "available" || status.state === "imported" || status.state === "blocked"),
  );
}

/** One sentence naming what can still be copied, or what already was. */
export function houston1ImportDescription(statuses: Houston1ImportStatuses): string {
  const parts: string[] = [];
  if (statuses.tasks?.state === "available") {
    parts.push(
      `${plural(statuses.tasks.workspaceCount ?? 0, "project", "projects")} and ` +
        `${plural(statuses.tasks.taskCount, "task", "tasks")} from Houston 1`,
    );
  }
  if (statuses.taskSources?.state === "available") {
    parts.push(
      `${plural(statuses.taskSources.settings, "tracker setting", "tracker settings")} and ` +
        `${plural(statuses.taskSources.links, "linked task", "linked tasks")}`,
    );
  }
  if (statuses.slack?.state === "available") {
    parts.push(
      `${plural(statuses.slack.channels, "Slack channel", "Slack channels")} and ` +
        `${plural(statuses.slack.requests, "request", "requests")}`,
    );
  }
  if (parts.length > 0) return `Houston can copy ${parts.join("; ")}.`;
  if (statuses.tasks?.state === "imported") {
    return `Houston 1's ${plural(statuses.tasks.counts.workspaces ?? 0, "project", "projects")} and ${plural(
      statuses.tasks.counts.tasks,
      "task",
      "tasks",
    )} were imported on ${statuses.tasks.at.slice(0, 10)}.`;
  }
  if (statuses.tasks?.state === "blocked") {
    return "Houston 1 tasks cannot be imported while the v2 backlog already has tasks. Houston 1's data stays in its own database.";
  }
  const reason = [statuses.taskSources, statuses.slack]
    .map((status) => (status?.state === "blocked" ? status.reason : null))
    .filter((value): value is string => value !== null);
  if (reason.length > 0) return reason.join(" ");
  return "Houston 1 data was imported.";
}

/** What a failed step should say: the message from the server, never a generic failure. */
export function houston1ImportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : "The Houston 1 import failed.";
}
