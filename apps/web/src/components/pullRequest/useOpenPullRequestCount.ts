import type { PullRequestListInput } from "@t3tools/contracts";

import { type EnvironmentQueryTarget, usePullRequestList } from "~/state/pullRequests";
import type { MergedPullRequestList } from "./pullRequestList.logic";
import { usePullRequestScope, type PullRequestsSearch } from "./usePullRequestListView";

/** The page's default view: open pull requests authored by this user. */
const OPEN_PULL_REQUESTS_SEARCH: PullRequestsSearch = {
  involvement: "authored",
  state: "open",
};
// The page reads one page of ninety-nine; the nav badge counts the same page.
const COUNT_PAGE_SIZE = 99;

export function openPullRequestCount(data: MergedPullRequestList | null): number | null {
  const count = data?.entries.length ?? 0;
  return count > 0 ? count : null;
}

/** Open pull requests the Pull requests page lists, or null while unknown or empty. */
export function useOpenPullRequestCount(): number | null {
  const { environmentQueries, projectsKnown, pullRequestsSupported } =
    usePullRequestScope(OPEN_PULL_REQUESTS_SEARCH);
  const targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> =
    pullRequestsSupported && projectsKnown
      ? environmentQueries.map(({ environmentId, projectIds }) => ({
          environmentId,
          input: {
            state: "open",
            involvement: "authored",
            limit: COUNT_PAGE_SIZE,
            ...(projectIds ? { projectIds } : {}),
          },
        }))
      : [];
  const { data, error, isPending } = usePullRequestList(targets);
  if (!pullRequestsSupported || !projectsKnown || isPending || error !== null) return null;
  return openPullRequestCount(data);
}
