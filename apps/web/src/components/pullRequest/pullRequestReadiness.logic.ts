import type {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestDetailView,
  PullRequestReviewThread,
  PullRequestUpdateMethod,
} from "@houston-app/contracts";

import { latestPullRequestReviewOutcomes } from "./pullRequestDetail.logic";

/** One reviewer on the readiness card, however a host happened to case their login. */
export interface PullRequestReadinessReviewer {
  readonly key: string;
  readonly actor: PullRequestActor | null;
  readonly outcome: "approved" | "changes-requested" | null;
  readonly stale: boolean;
}

export interface PullRequestReadiness {
  /** Only an open pull request has a merge for the rows to be in the way of. */
  readonly open: boolean;
  readonly passedChecks: number;
  readonly checksLabel: string | null;
  readonly checksMeta: string | null;
  readonly reviewerEntries: ReadonlyArray<PullRequestReadinessReviewer>;
  readonly reviewOutcome: "approved" | "changes-requested" | null;
  readonly reviewLabel: string;
  readonly reviewMeta: string | null;
  /** Threads still open on a line, oldest first. */
  readonly unresolvedThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly conflicting: boolean;
  readonly conflictsLabel: string;
  readonly conflictsMeta: string | null;
}

/** One reviewer, however a host happens to have cased their login this time. */
function reviewerKey(login: string): string {
  return login.toLowerCase();
}

function commitCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "commit" : "commits"}`;
}

/**
 * Whether a pull request can merge, derived from what the host reported: the checks rollup,
 * each reviewer's standing verdict, and the branch's mergeability against its base. The card
 * lays out the answer; this says what it says.
 */
export function pullRequestReadiness({
  detail,
  activityPending,
  checksState,
  checksStale,
  checksSummary,
  freshness,
}: {
  detail: Pick<
    PullRequestDetailView,
    | "state"
    | "mergeability"
    | "baseBranch"
    | "checks"
    | "comments"
    | "commits"
    | "reviewers"
    | "commentsTruncated"
    | "reviewThreads"
  >;
  activityPending: boolean;
  checksState: PullRequestChecksState | null;
  checksStale: boolean;
  checksSummary: string | null;
  freshness: {
    readonly behindBy: number | null;
    readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
  } | null;
}): PullRequestReadiness {
  // Skipped and neutral runs count as passed here, as they do in the row's meta count.
  const passedChecks = detail.checks.filter(
    (check) =>
      check.status === "success" || check.status === "skipped" || check.status === "neutral",
  ).length;
  const checksPassing = checksState === "passing";
  const checksLabel = checksPassing && !checksStale ? "All checks passed" : checksSummary;
  const checksMeta =
    checksStale || detail.checks.length === 0
      ? null
      : `${passedChecks.toLocaleString()} of ${detail.checks.length.toLocaleString()}`;

  const reviewOutcomes = latestPullRequestReviewOutcomes(detail.comments, detail.commits);
  const outcomeByLogin = new Map(
    reviewOutcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : [],
    ),
  );
  const reviewerEntries: PullRequestReadinessReviewer[] = [
    ...detail.reviewers.map((actor) => {
      const entry = outcomeByLogin.get(reviewerKey(actor.login));
      return {
        key: actor.login,
        actor,
        outcome:
          entry?.outcome === "approved" || entry?.outcome === "changes-requested"
            ? entry.outcome
            : null,
        stale: entry?.stale ?? false,
      };
    }),
    ...reviewOutcomes
      .filter(
        (entry) =>
          !detail.reviewers.some(
            (actor) =>
              entry.actor !== null && reviewerKey(actor.login) === reviewerKey(entry.actor.login),
          ),
      )
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome:
          entry.outcome === "approved" || entry.outcome === "changes-requested"
            ? entry.outcome
            : null,
        stale: entry.stale,
      })),
  ];
  const standing = reviewOutcomes.filter((entry) => !entry.stale);
  const changesRequested = standing.filter((entry) => entry.outcome === "changes-requested");
  const approved = standing.filter((entry) => entry.outcome === "approved");
  const names = (entries: typeof standing) => {
    const first = entries[0]?.actor?.login ?? "ghost";
    return entries.length > 1 ? `${first} and ${entries.length - 1} more` : first;
  };
  const reviewOutcome =
    changesRequested.length > 0
      ? ("changes-requested" as const)
      : approved.length > 0
        ? ("approved" as const)
        : null;
  const reviewLabel = activityPending
    ? "Reading reviews"
    : changesRequested.length > 0
      ? `Changes requested by ${names(changesRequested)}`
      : approved.length > 0
        ? `Approved by ${names(approved)}`
        : reviewerEntries.length > 0
          ? "Waiting on reviews"
          : "No reviews yet";
  const reviewMeta =
    activityPending || reviewerEntries.length === 0
      ? null
      : `${approved.length} of ${reviewerEntries.length} approved`;

  const unresolvedThreads = detail.reviewThreads
    .filter((thread) => !thread.isResolved)
    .toSorted(
      (left, right) =>
        Date.parse(left.comments[0]?.createdAt ?? "") -
        Date.parse(right.comments[0]?.createdAt ?? ""),
    );

  const open = detail.state === "open";
  const conflicting = open && detail.mergeability === "conflicting";
  const conflictsLabel = conflicting
    ? `Conflicts with ${detail.baseBranch}`
    : detail.mergeability === "unknown"
      ? `Checking for conflicts with ${detail.baseBranch}`
      : freshness
        ? `Behind ${detail.baseBranch}${
            freshness.behindBy === null
              ? ""
              : ` by ${freshness.behindBy.toLocaleString()} ${
                  freshness.behindBy === 1 ? "commit" : "commits"
                }`
          }`
        : `No conflicts with ${detail.baseBranch}`;

  return {
    open,
    passedChecks,
    checksLabel,
    checksMeta,
    reviewerEntries,
    reviewOutcome,
    reviewLabel,
    reviewMeta,
    unresolvedThreads,
    conflicting,
    conflictsLabel,
    conflictsMeta: activityPending ? null : commitCountLabel(detail.commits.length),
  };
}
