import type { EnvironmentId, ProjectId } from "@houston-app/contracts";

import type { IssueListPreferences } from "./issueListPreferences";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  /** Part of the panel tab's identity, so a link reopens the tab a row press opened. */
  readonly selectedHost?: string;
  readonly tracker?: string;
  readonly scope?: string;
  readonly key?: string;
}

/** The router reads a bare `key=42` as a number. */
function bounded(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : undefined;
}

/** A search key that is either present as a string or absent, never present as undefined. */
function present<K extends string, V extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

const labels = (raw: unknown): ReadonlyArray<string> | undefined => {
  const names = (Array.isArray(raw) ? raw : [raw]).flatMap((name) => bounded(name) ?? []);
  return names.length === 0 ? undefined : names.slice(0, 20);
};

/** The search an issues location carries, normalized, for the route and for a page tab. */
export function validateIssuesSearch(raw: Record<string, unknown>): IssuesSearch {
  return {
    who:
      raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
    status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
    ...present("host", bounded(raw.host)),
    // `q`, `label`, `assignee` and `order` are always own keys: the router lays these over the
    // parent route's unvalidated search, where a key left out would keep its raw value.
    q: bounded(raw.q),
    label: labels(raw.label),
    assignee: bounded(raw.assignee),
    order: raw.order === "created" ? "created" : undefined,
    ...present<"selectedEnvironmentId", EnvironmentId>(
      "selectedEnvironmentId",
      bounded(raw.selectedEnvironmentId),
    ),
    ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
    ...present("selectedHost", bounded(raw.selectedHost)),
    ...present("tracker", bounded(raw.tracker)),
    ...present("scope", bounded(raw.scope)),
    ...present("key", bounded(raw.key)),
  };
}
