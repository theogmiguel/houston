import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import type { PullRequestChecksState } from "@houston-app/contracts";

/** The pull request a thread row badges, in the order the row prefers them. */
export type RowPullRequestState = "open" | "draft" | "merged" | "closed";

export interface RowPullRequest {
  readonly number: number;
  readonly url: string;
  /** Null when only the branch's linked pull request is known and no snapshot has synced. */
  readonly state: RowPullRequestState | null;
  readonly title: string | null;
  readonly checksState: PullRequestChecksState | null;
}

const ROW_PULL_REQUEST_RANK: Record<RowPullRequestState, number> = {
  open: 0,
  draft: 1,
  merged: 2,
  closed: 3,
};

function rowPullRequestState(
  snapshot: NonNullable<EnvironmentThreadShell["pullRequests"][number]["snapshot"]>,
): RowPullRequestState {
  return snapshot.state === "open" && snapshot.isDraft ? "draft" : snapshot.state;
}

/**
 * The most relevant pull request of a thread: open, then draft, merged and closed, newest
 * first within a state. Links without a synced snapshot rank last; the branch's linked pull
 * request is used when the thread has no links.
 */
export function resolveRowPullRequest(
  thread: Pick<EnvironmentThreadShell, "pullRequests" | "branchPullRequest">,
): RowPullRequest | null {
  const ranked = thread.pullRequests.map((link) => {
    const state = link.snapshot === null ? null : rowPullRequestState(link.snapshot);
    const recency = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
    return {
      link,
      state,
      rank: state === null ? Number.MAX_SAFE_INTEGER : ROW_PULL_REQUEST_RANK[state],
      recency: Number.isNaN(recency) ? 0 : recency,
    };
  });
  ranked.sort((a, b) => a.rank - b.rank || b.recency - a.recency);
  const best = ranked[0];
  if (best !== undefined) {
    return {
      number: best.link.number,
      url: best.link.url,
      state: best.state,
      title: best.link.snapshot?.title ?? null,
      checksState: best.link.snapshot?.checksState ?? null,
    };
  }
  const branch = thread.branchPullRequest;
  if (branch === null || branch === undefined) return null;
  return {
    number: branch.number,
    url: branch.url,
    state: null,
    title: null,
    checksState: null,
  };
}
