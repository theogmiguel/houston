import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  SourceControlProviderKind,
} from "@houston-app/contracts";
import { sourceControlClients } from "@houston-app/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";

import type { IssueCandidatesTarget } from "~/state/issues";

/** What a filter needs from a held page: the trackers it read and the rows it listed. */
export interface FilterableIssuePage {
  readonly answer: Pick<IssueListResult, "trackers">;
  readonly entries: ReadonlyArray<IssueListEntry>;
}

/** The scopes whose labels and people a list filter offers, each reached through one project. */
export function issueFilterScopes(
  held: ReadonlyMap<EnvironmentId, FilterableIssuePage>,
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<IssueCandidatesTarget> {
  const scopes: IssueCandidatesTarget[] = [];
  for (const [environmentId, page] of held) {
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const identity = project.repositoryIdentity;
      const kind = identity?.provider as SourceControlProviderKind | undefined;
      const scope = sourceControlClients.issueScope(identity);
      if (!identity || !kind || scope === null) continue;
      const host = sourceControlClients.changeRequestHost(identity, kind);
      const tracker = page.answer.trackers.find(
        (t) => String(t.tracker) === kind && t.host.toLowerCase() === host.toLowerCase(),
      );
      if (!tracker?.configured || tracker.capabilities === null) continue;
      if (
        scopes.some(
          (s) => s.input.scope.toLowerCase() === scope.toLowerCase() && s.input.host === host,
        )
      )
        continue;
      scopes.push({
        environmentId,
        input: { projectId: project.id, tracker: tracker.tracker, host, scope },
      });
    }
    // A tracker bound in settings (a Linear team) is no repository's; its rows name its scope.
    for (const entry of page.entries) {
      const tracker = page.answer.trackers.find(
        (t) => t.tracker === entry.tracker && t.host.toLowerCase() === entry.host.toLowerCase(),
      );
      if (!tracker?.configured) continue;
      if (!tracker.capabilities?.labels && !tracker.capabilities?.assignees) continue;
      if (
        scopes.some(
          (s) =>
            s.input.scope.toLowerCase() === entry.scope.toLowerCase() &&
            s.input.host?.toLowerCase() === entry.host.toLowerCase(),
        )
      )
        continue;
      scopes.push({
        environmentId,
        input: {
          projectId: entry.projectId,
          tracker: entry.tracker,
          host: entry.host,
          scope: entry.scope,
        },
      });
    }
  }
  return scopes;
}
