import type {
  HoustonTaskSourceConflict,
  HoustonTaskSourceProvider,
  HoustonTaskSourceSettings,
  HoustonTaskSourceSettingsInput,
} from "@houston-app/contracts/houston/taskSources";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";

export const TASK_SOURCE_PROVIDER_LABELS: Readonly<Record<HoustonTaskSourceProvider, string>> = {
  github_issues: "GitHub issues",
  notion: "Notion",
};

export function taskSourceProviderLabel(provider: HoustonTaskSourceProvider): string {
  return TASK_SOURCE_PROVIDER_LABELS[provider];
}

const CONFLICT_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "title",
  description: "description",
  status: "status",
  "project.title": "project title",
  "project.description": "project description",
  "project.identity": "project",
};

export function conflictFieldLabel(field: string): string {
  return CONFLICT_FIELD_LABELS[field] ?? field;
}

/** The field name as a card heading. */
export function conflictFieldTitle(field: string): string {
  const label = conflictFieldLabel(field);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "title and status differ", or a longer list when a link carries more than two. */
export function conflictSummary(conflicts: ReadonlyArray<HoustonTaskSourceConflict>): string {
  const fields = conflicts.map((conflict) => conflictFieldLabel(conflict.field));
  if (fields.length === 0) return "no differences";
  if (fields.length === 1) return `${fields[0]} differs`;
  return `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)} differ`;
}

export function conflictLabel(
  provider: HoustonTaskSourceProvider,
  conflicts: ReadonlyArray<HoustonTaskSourceConflict>,
): string {
  return `${taskSourceProviderLabel(provider)} · ${conflictSummary(conflicts)}`;
}

export interface SourceStateLabel {
  readonly label: string;
  readonly tone: "success" | "error" | "default";
}

export function taskSourceState(settings: HoustonTaskSourceSettings): SourceStateLabel {
  if (!settings.enabled) return { label: "Off", tone: "default" };
  if (settings.lastError !== null) return { label: "Failed", tone: "error" };
  if (settings.lastSyncAt !== null) return { label: "Synced", tone: "success" };
  return { label: "Ready", tone: "default" };
}

export function slackConnectionState(info: HoustonSlackInfo): SourceStateLabel {
  if (!info.enabled) return { label: "Off", tone: "default" };
  if (info.error !== null) return { label: "Failed", tone: "error" };
  if (info.connection === "connected") return { label: "Connected", tone: "success" };
  if (info.connection === "connecting") return { label: "Connecting", tone: "default" };
  if (info.connection === "retrying") return { label: "Retrying", tone: "default" };
  return { label: "Off", tone: "default" };
}

const SLACK_REQUEST_LABELS: Readonly<Record<HoustonSlackRequest["state"], string>> = {
  pending: "Awaiting approval",
  queued: "Queued",
  started: "Started",
  refused: "Refused",
  closed: "Closed",
};

export function slackRequestLabel(request: HoustonSlackRequest): string {
  if (request.state === "queued" && request.queuePosition !== undefined) {
    return `Queued · ${request.queuePosition}`;
  }
  return SLACK_REQUEST_LABELS[request.state];
}

export function slackRequestTone(
  request: HoustonSlackRequest,
): "success" | "error" | "warning" | "info" | "default" {
  switch (request.state) {
    case "started":
      return "success";
    case "refused":
      return "error";
    case "pending":
      return "warning";
    case "queued":
      return "info";
    case "closed":
      return "default";
  }
}

/** The stored values as a write input, with `patch` applied. */
export function settingsInputFrom(
  settings: HoustonTaskSourceSettings,
  patch: Partial<HoustonTaskSourceSettingsInput> = {},
): HoustonTaskSourceSettingsInput {
  return {
    enabled: settings.enabled,
    githubRepository: settings.githubRepository,
    githubLabel: settings.githubLabel,
    githubAssignedUser: settings.githubAssignedUser,
    notionDataSourceId: settings.notionDataSourceId,
    notionTitlePropertyId: settings.notionTitlePropertyId,
    notionDescriptionPropertyId: settings.notionDescriptionPropertyId,
    notionStatusPropertyId: settings.notionStatusPropertyId,
    notionAssigneePropertyId: settings.notionAssigneePropertyId,
    notionProjectRelationPropertyId: settings.notionProjectRelationPropertyId,
    notionAssigneeUserId: settings.notionAssigneeUserId,
    notionActiveStatusValues: settings.notionActiveStatusValues,
    notionProjectsDataSourceId: settings.notionProjectsDataSourceId,
    notionProjectTitlePropertyId: settings.notionProjectTitlePropertyId,
    notionProjectDescriptionPropertyId: settings.notionProjectDescriptionPropertyId,
    notionPrUrlPropertyId: settings.notionPrUrlPropertyId,
    notionStatusMapping: settings.notionStatusMapping,
    ...patch,
  };
}

/** A comma-separated list as stored Notion status values. */
export function parseStatusValues(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function joinStatusValues(values: ReadonlyArray<string>): string {
  return values.join(", ");
}

export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
