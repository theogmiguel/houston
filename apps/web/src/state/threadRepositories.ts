import { createEnvironmentRpcQueryAtomFamily } from "@houston-app/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type ProjectId } from "@houston-app/contracts";

import {
  repositoryChoice,
  type RepositoryChoice,
} from "../components/diffs/multiRepositoryChanges.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/** The repositories a project covers, with each one's branch or the reason it could not be read. */
export const projectRepositories = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:repositories",
  tag: WS_METHODS.houstonProjectsRepositoriesList,
  staleTimeMs: 5_000,
});

export interface ThreadRepositoryTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export function useThreadRepositories(target: ThreadRepositoryTarget | null): {
  readonly repositories: ReadonlyArray<RepositoryChoice>;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const worktreePath = target?.worktreePath ?? null;
  const query = useEnvironmentQuery(
    target !== null && worktreePath === null
      ? projectRepositories({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        })
      : null,
  );

  if (target === null) {
    return { repositories: [], isLoading: false, error: null, refresh: () => {} };
  }
  if (worktreePath !== null) {
    return {
      repositories: [
        repositoryChoice({
          key: ".",
          root: worktreePath,
          branch: null,
          detached: false,
          kind: "tracked",
        }),
      ],
      isLoading: false,
      error: null,
      refresh: () => {},
    };
  }

  return {
    repositories: (query.data?.repositories ?? []).map(repositoryChoice),
    isLoading: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}
