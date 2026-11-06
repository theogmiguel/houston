import type { PullRequestActivity, PullRequestDetail } from "@houston-app/contracts";
import type { ReviewGuideGenerationInput } from "@houston-app/provider-core/server/textGeneration";

const FLAT_PATTERN = /<!--[\s\S]*?-->/g;
const WHITESPACE_RUN = /\s+/g;

const SETTLED_REMARK_CHARS = 200;

function oneLine(text: string): string {
  const flat = text.replace(FLAT_PATTERN, "").replace(WHITESPACE_RUN, " ").trim();
  return flat.length > SETTLED_REMARK_CHARS ? `${flat.slice(0, SETTLED_REMARK_CHARS)}…` : flat;
}

function settledReviewSummary(activity: PullRequestActivity): string {
  return activity.reviewThreads
    .filter((thread) => thread.isResolved || thread.isOutdated)
    .flatMap((thread) => {
      const opener = thread.comments[0];
      if (opener === undefined) return [];
      const who = opener.author?.login ?? "ghost";
      const state = thread.isResolved ? "resolved" : "outdated";
      return [`- ${thread.path} (${state}, ${who}): ${oneLine(opener.body)}`];
    })
    .join("\n");
}

export function reviewGuideInputFromPullRequest(
  detail: PullRequestDetail,
  activity: PullRequestActivity,
  baseCommit: string,
): Omit<ReviewGuideGenerationInput, "cwd" | "modelSelection"> {
  return {
    number: detail.number,
    title: detail.title,
    description: detail.body,
    baseBranch: detail.baseBranch,
    baseCommit,
    settledReview: settledReviewSummary(activity),
  };
}
