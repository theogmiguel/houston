// GitHub for the queue: reads through upstream's PullRequestService plus one facts query for what
// its detail lacks, the merge pinned to one commit, and the merged report upstream's reactors read.
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import type { ProjectTarget } from "./Project.ts";
import type { Facts } from "./rules.ts";
import type { HoustonMergeQueueMergeMethod } from "@t3tools/contracts/houston/mergeQueue";
import { nowIso } from "./Store.ts";

/** One read: the facts, and the repositories GitHub answered for the pull request and its head. */
export interface PullRead {
  readonly facts: Facts;
  readonly repository: string;
  readonly headRepository: string | null;
}

const MERGE_QUEUE_FACTS = `query MergeQueueFacts($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) { mergeStateStatus reviewDecision isDraft headRefOid }
  }
}`;

const FactsAnswer = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
            pullRequest: Schema.NullOr(
              Schema.Struct({
                mergeStateStatus: Schema.NullOr(Schema.String),
                reviewDecision: Schema.NullOr(Schema.String),
                isDraft: Schema.Boolean,
                headRefOid: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeFacts = Schema.decodeUnknownOption(Schema.fromJsonString(FactsAnswer));

const MergeAnswer = Schema.Struct({ sha: Schema.optional(Schema.String) });
const decodeMerge = Schema.decodeUnknownOption(Schema.fromJsonString(MergeAnswer));

const REVIEW_DECISIONS: Record<string, Facts["reviewDecision"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
};

/** GraphQL sits beside the REST root on GitHub.com and GHE.com, and at `/api/graphql` on GHES. */
const graphqlPath = (host: string) =>
  host === "github.com" || host.endsWith(".ghe.com") ? "graphql" : "../graphql";

const errorText = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const detail = (error as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
    const githubErrors = (error as { readonly githubErrors?: ReadonlyArray<string> }).githubErrors;
    const message = (error as { readonly message?: unknown }).message;
    const text = typeof message === "string" && message.length > 0 ? message : String(error);
    return githubErrors === undefined || githubErrors.length === 0
      ? text
      : `${text}: ${githubErrors.join("; ")}`;
  }
  return String(error);
};

export class HoustonMergeQueueGitHub extends Context.Service<
  HoustonMergeQueueGitHub,
  {
    /** A fresh read of the pull request; fails with GitHub's words. */
    readonly read: (target: ProjectTarget, number: number) => Effect.Effect<PullRead, string>;
    /** `PUT …/pulls/{n}/merge` with `sha`, so GitHub merges exactly that commit or nothing. */
    readonly merge: (
      target: ProjectTarget,
      number: number,
      sha: string,
      method: HoustonMergeQueueMergeMethod,
    ) => Effect.Effect<string | null, string>;
    /** Tells upstream's pull request state the queue merged it. */
    readonly reportMerged: (target: ProjectTarget, number: number) => Effect.Effect<void>;
  }
>()("houston/houston/mergeQueue/GitHubQueueClient/HoustonMergeQueueGitHub") {}

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const github = yield* GitHubRest.GitHubRest;

  const reference = (target: ProjectTarget, number: number) => ({
    projectId: target.projectId,
    host: target.host,
    repository: target.repository,
    number,
    allowStale: false,
  });

  const factsQuery = (target: ProjectTarget, number: number) => {
    const [owner, name] = target.repository.split("/");
    return github
      .rest({
        host: target.host,
        operation: "houston.mergeQueue.facts",
        method: "POST",
        path: graphqlPath(target.host),
        body: { query: MERGE_QUEUE_FACTS, variables: { owner, name, number } },
      })
      .pipe(
        Effect.mapError(errorText),
        Effect.flatMap((response) => {
          const decoded = decodeFacts(response.body);
          if (decoded._tag === "None") {
            return Effect.fail(
              `GitHub answered the merge queue facts query with ${response.status}`,
            );
          }
          const answer = decoded.value;
          if (answer.errors !== undefined && answer.errors.length > 0) {
            return Effect.fail(answer.errors.map((error) => error.message).join("; "));
          }
          const repository = answer.data?.repository ?? null;
          return repository === null
            ? Effect.fail(`GitHub has no repository ${target.repository}`)
            : Effect.succeed(repository);
        }),
      );
  };

  const read: HoustonMergeQueueGitHub["Service"]["read"] = Effect.fn(
    "HoustonMergeQueueGitHub.read",
  )(function* (target, number) {
    const ref = reference(target, number);
    const [detail, activity, checks, extra] = yield* Effect.all(
      [
        pullRequests.detail(ref).pipe(Effect.mapError(errorText)),
        pullRequests.activity(ref).pipe(Effect.mapError(errorText)),
        pullRequests.checks(ref).pipe(Effect.mapError(errorText)),
        factsQuery(target, number),
      ],
      { concurrency: "unbounded" },
    );
    const pull = extra.pullRequest;
    const unresolved = activity.reviewThreads.filter((thread) => !thread.isResolved).length;
    const facts: Facts = {
      readAt: yield* nowIso,
      error: null,
      state: detail.state,
      isDraft: detail.isDraft || pull?.isDraft === true,
      headSha: detail.headSha ?? pull?.headRefOid ?? "",
      headRef: detail.headBranch,
      baseRef: detail.baseBranch,
      title: detail.title,
      url: detail.url,
      checks: (checks?.checks ?? detail.checks).map((check) => ({
        name: check.name,
        status: check.status,
        required: check.required === true,
      })),
      reviewDecision: REVIEW_DECISIONS[pull?.reviewDecision ?? ""] ?? null,
      mergeState: pull?.mergeStateStatus ?? null,
      mergeability: detail.mergeability,
      unresolvedThreads: unresolved,
      threadsTruncated: activity.reviewThreadsTruncated === true,
      mergeMethods: { ...detail.mergeCapabilities },
      defaultBranch: extra.defaultBranchRef?.name ?? null,
    };
    return {
      facts,
      repository: detail.repository,
      headRepository: detail.headRepositoryNameWithOwner ?? null,
    };
  });

  const merge: HoustonMergeQueueGitHub["Service"]["merge"] = (target, number, sha, method) =>
    github
      .rest({
        host: target.host,
        operation: "houston.mergeQueue.merge",
        method: "PUT",
        path: `repos/${target.repository}/pulls/${number}/merge`,
        body: { sha, merge_method: method },
      })
      .pipe(
        Effect.mapError(
          (error) => `GitHub refused the ${method} merge of PR #${number}: ${errorText(error)}`,
        ),
        Effect.map((response) => {
          const decoded = decodeMerge(response.body);
          return decoded._tag === "Some" ? (decoded.value.sha ?? null) : null;
        }),
      );

  const reportMerged: HoustonMergeQueueGitHub["Service"]["reportMerged"] = (target, number) =>
    pullRequests
      .reportState({
        reference: {
          projectId: target.projectId,
          host: target.host,
          repository: target.repository,
          number,
        },
        state: "merged",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Reporting the merge of PR #${number} failed.`, cause),
        ),
      );

  return HoustonMergeQueueGitHub.of({ read, merge, reportMerged });
});

export const layer = Layer.effect(HoustonMergeQueueGitHub, make);
