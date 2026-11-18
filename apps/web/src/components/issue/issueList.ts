import type {
  EnvironmentId,
  IssueListCursors,
  IssueListEntry,
  IssueListProjectError,
  IssueListResult,
  IssueListSort,
  IssueTrackerSummary,
  SourceControlProviderKind,
} from "@houston-app/contracts";
import { sourceControlClients } from "@houston-app/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";

import type { EnvironmentIssueEntry } from "./IssueRow";

/** Rows from every environment that answered, with any continuation pages laid over them. */
export interface HeldIssuePage {
  readonly answer: IssueListResult;
  readonly entries: ReadonlyArray<IssueListEntry>;
  readonly errors: ReadonlyArray<IssueListProjectError>;
  readonly nextCursors: IssueListCursors;
  /** Why the last "Load more" failed, until a retry succeeds or a new first page arrives. */
  readonly moreFailure: string | null;
}

export function issueTrackerKey(tracker: Pick<IssueTrackerSummary, "tracker" | "host">): string {
  return `${tracker.tracker} ${tracker.host.toLowerCase()}`;
}

/** The cursors of one tracker host, so its "Load more" leaves the other trackers where they are. */
export function issueCursorsForHost(cursors: IssueListCursors, host: string): IssueListCursors {
  return Object.fromEntries(Object.entries(cursors).filter(([key]) => key.startsWith(`${host} `)));
}

/** Newest first by the date the trackers were asked to sort on, so merged rows keep that order. */
export function issueOrder(sort: IssueListSort) {
  const date = (issue: IssueListEntry) =>
    Date.parse(sort === "created" ? issue.createdAt : issue.updatedAt);
  return (left: IssueListEntry, right: IssueListEntry) => date(right) - date(left);
}

/** Continuations are laid over the first page they continue; a new first page forgets them. */
export function holdIssuePages(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  pages: ReadonlyMap<EnvironmentId, HeldIssuePage>,
): ReadonlyMap<EnvironmentId, HeldIssuePage> {
  const next = new Map<EnvironmentId, HeldIssuePage>();
  for (const [environmentId, answer] of answers) {
    const previous = pages.get(environmentId);
    next.set(
      environmentId,
      previous?.answer === answer
        ? previous
        : {
            answer,
            entries: answer.entries,
            errors: answer.errors,
            nextCursors: answer.nextCursors,
            moreFailure: null,
          },
    );
  }
  return next;
}

export function groupIssues(
  held: ReadonlyMap<EnvironmentId, HeldIssuePage>,
  query: string,
  projects: ReadonlyArray<EnvironmentProject>,
  sort: IssueListSort = "updated",
) {
  const byTracker = new Map<
    string,
    {
      tracker: IssueTrackerSummary;
      rows: EnvironmentIssueEntry[];
      errors: Array<{ projectTitle: string; message: string; environmentId: EnvironmentId }>;
      more: EnvironmentId[];
    }
  >();
  const listed = new Set<string>();
  const needle = query.toLowerCase();
  for (const [environmentId, page] of held) {
    for (const tracker of page.answer.trackers) {
      const key = issueTrackerKey(tracker);
      if (!byTracker.has(key)) byTracker.set(key, { tracker, rows: [], errors: [], more: [] });
      const group = byTracker.get(key)!;
      if (!group.tracker.configured && tracker.configured) group.tracker = tracker;
      if (Object.keys(page.nextCursors).some((c) => c.startsWith(`${tracker.host} `)))
        group.more.push(environmentId);
    }
    for (const entry of page.entries) {
      const key = issueTrackerKey(entry);
      const group = byTracker.get(key);
      if (!group) continue;
      // A tracker that cannot search is narrowed here instead.
      if (
        needle.length > 0 &&
        group.tracker.capabilities?.search !== true &&
        !entry.title.toLowerCase().includes(needle) &&
        !entry.displayKey.toLowerCase().includes(needle)
      )
        continue;
      // Environments holding the same repository answer the same issue; the first one keeps it.
      if (listed.has(entry.url)) continue;
      listed.add(entry.url);
      group.rows.push({ ...entry, environmentId });
    }
    for (const error of page.errors) {
      const project = projects.find(
        (p) => p.environmentId === environmentId && p.id === error.projectId,
      );
      const kind = project?.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      const host = kind
        ? sourceControlClients.changeRequestHost(project?.repositoryIdentity, kind)
        : null;
      const group =
        (host ? byTracker.get(`${kind} ${host.toLowerCase()}`) : undefined) ??
        [...byTracker.values()][0];
      group?.errors.push({ ...error, environmentId });
    }
  }
  for (const group of byTracker.values()) {
    group.rows.sort(issueOrder(sort));
  }
  return [...byTracker.values()].sort((a, b) =>
    issueTrackerKey(a.tracker).localeCompare(issueTrackerKey(b.tracker)),
  );
}
