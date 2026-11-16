import type { PullRequestActivity, PullRequestDetail } from "@houston-app/contracts";
import type { ReviewGuideGenerationInput } from "@houston-app/provider-core/server/textGeneration";

const SETTLED_REMARK_CHARS = 200;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const WHITESPACE_RUNS = /\s+/g;

function oneLine(text: string): string {
  const flat = text.replace(HTML_COMMENT, "").replace(WHITESPACE_RUNS, " ").trim();
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
