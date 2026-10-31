// GitHub for the queue: reads through upstream's PullRequestService plus one facts query for what
// its detail lacks, the merge pinned to one commit, and the merged report upstream's reactors read.
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import type { ProjectTarget } from "./Project.ts";
import type { Facts, HandOffFacts } from "./rules.ts";
import type { HoustonMergeQueueMergeMethod } from "@t3tools/contracts/houston/mergeQueue";
import { nowIso } from "./Store.ts";

/** One read: the facts, and the repositories GitHub answered for the pull request and its head. */
export interface PullRead {
  readonly facts: Facts;
  readonly repository: string;
  readonly headRepository: string | null;
}

// An older GitHub Enterprise lacks the hand-off fields; the query is then sent without them.
const HAND_OFF_REPOSITORY_FIELDS = "autoMergeAllowed";
const HAND_OFF_PULL_FIELDS = `isMergeQueueEnabled
      mergeQueueEntry { position headCommit { oid } }
      autoMergeRequest { mergeMethod }
      timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_DISABLED_EVENT]) {
        nodes { __typename ... on RemovedFromMergeQueueEvent { reason } ... on AutoMergeDisabledEvent { reason } }
      }`;

const factsQueryText = (
  handOff: boolean,
) => `query MergeQueueFacts($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    ${handOff ? HAND_OFF_REPOSITORY_FIELDS : ""}
    pullRequest(number: $number) {
      id mergeStateStatus reviewDecision isDraft headRefOid
      ${handOff ? HAND_OFF_PULL_FIELDS : ""}
    }
  }
}`;

/** A GraphQL error that names a field the host's schema does not have. */
const SCHEMA_ERROR =
  /Field '\w+' doesn't exist|Cannot query field|undefinedField|Unknown argument|Expected type/i;

const FactsAnswer = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
            autoMergeAllowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.optional(Schema.NullOr(Schema.String)),
                mergeStateStatus: Schema.NullOr(Schema.String),
                reviewDecision: Schema.NullOr(Schema.String),
                isDraft: Schema.Boolean,
                headRefOid: Schema.NullOr(Schema.String),
                isMergeQueueEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
                mergeQueueEntry: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({
                      position: Schema.optional(Schema.NullOr(Schema.Number)),
                      headCommit: Schema.optional(
                        Schema.NullOr(Schema.Struct({ oid: Schema.String })),
                      ),
                    }),
                  ),
                ),
                autoMergeRequest: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({ mergeMethod: Schema.optional(Schema.NullOr(Schema.String)) }),
                  ),
                ),
                timelineItems: Schema.optional(
                  Schema.NullOr(
                    Schema.Struct({
                      nodes: Schema.Array(
                        Schema.NullOr(
                          Schema.Struct({ reason: Schema.optional(Schema.NullOr(Schema.String)) }),
                        ),
                      ),
                    }),
                  ),
                ),
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

const MutationAnswer = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeMutation = Schema.decodeUnknownOption(Schema.fromJsonString(MutationAnswer));

// Each hand-off is pinned: GitHub refuses it unless the head is still `expectedHeadOid`.
const ENQUEUE = `mutation HoustonMergeQueueEnqueue($id: ID!, $oid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $oid }) { mergeQueueEntry { position } }
}`;
const ENABLE_AUTO_MERGE = `mutation HoustonMergeQueueAutoMerge($id: ID!, $oid: GitObjectID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $oid, mergeMethod: $method }) { pullRequest { number } }
}`;
const DEQUEUE = `mutation HoustonMergeQueueDequeue($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { position } }
}`;
const DISABLE_AUTO_MERGE = `mutation HoustonMergeQueueDisableAutoMerge($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } }
}`;

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
    /** Hands the pull request to GitHub at exactly `sha`; GitHub refuses it at any other head. */
    readonly handOff: (input: {
      readonly target: ProjectTarget;
      readonly number: number;
      readonly nodeId: string;
      readonly mode: "mergeQueue" | "autoMerge";
      readonly sha: string;
      readonly method: HoustonMergeQueueMergeMethod;
    }) => Effect.Effect<void, string>;
    /** Takes a hand-off back: leaves GitHub's merge queue, or turns auto-merge off. */
    readonly takeBack: (input: {
      readonly target: ProjectTarget;
      readonly number: number;
      readonly nodeId: string;
      readonly mode: "mergeQueue" | "autoMerge";
    }) => Effect.Effect<void, string>;
    /** `PATCH …/pulls/{n}` with `base`, for a stacked pull request whose dependency merged. */
    readonly retarget: (
      target: ProjectTarget,
      number: number,
      base: string,
    ) => Effect.Effect<void, string>;
    /** Upstream's revert action, which opens a revert pull request. */
    readonly revert: (target: ProjectTarget, number: number) => Effect.Effect<void, string>;
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

  const factsQueryWith = (target: ProjectTarget, number: number, handOff: boolean) => {
    const [owner, name] = target.repository.split("/");
    return github
      .rest({
        host: target.host,
        operation: "houston.mergeQueue.facts",
        method: "POST",
        path: graphqlPath(target.host),
        body: { query: factsQueryText(handOff), variables: { owner, name, number } },
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
            : Effect.succeed({ repository, handOff });
        }),
      );
  };

  /** The facts with the hand-off fields; once more without them on a schema that lacks them. */
  const factsQuery = (target: ProjectTarget, number: number) =>
    factsQueryWith(target, number, true).pipe(
      Effect.catchIf(
        (error: string) => SCHEMA_ERROR.test(error),
        () => factsQueryWith(target, number, false),
      ),
    );

  const graphql = (
    target: ProjectTarget,
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ) =>
    github
      .rest({
        host: target.host,
        operation,
        method: "POST",
        path: graphqlPath(target.host),
        body: { query, variables },
      })
      .pipe(
        Effect.mapError(errorText),
        Effect.flatMap((response) => {
          const decoded = decodeMutation(response.body);
          if (decoded._tag === "None") {
            return Effect.fail(`GitHub answered ${operation} with ${response.status}`);
          }
          const errors = decoded.value.errors ?? [];
          return errors.length > 0
            ? Effect.fail(errors.map((error) => error.message).join("; "))
            : Effect.succeed(decoded.value.data);
        }),
      );

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
    const pull = extra.repository.pullRequest;
    const unresolved = activity.reviewThreads.filter((thread) => !thread.isResolved).length;
    const letGo = pull?.timelineItems?.nodes.findLast((node) => node !== null)?.reason ?? null;
    const handOff: HandOffFacts | null =
      !extra.handOff || pull === null
        ? null
        : {
            mergeQueueRequired: pull.isMergeQueueEnabled === true,
            autoMergeAllowed: extra.repository.autoMergeAllowed === true,
            queueEntry:
              pull.mergeQueueEntry === null || pull.mergeQueueEntry === undefined
                ? null
                : {
                    position: pull.mergeQueueEntry.position ?? null,
                    headSha: pull.mergeQueueEntry.headCommit?.oid ?? null,
                  },
            autoMerge:
              pull.autoMergeRequest === null || pull.autoMergeRequest === undefined
                ? null
                : { method: pull.autoMergeRequest.mergeMethod?.toLowerCase() ?? null },
            letGo,
          };
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
      defaultBranch: extra.repository.defaultBranchRef?.name ?? null,
      handOff,
      nodeId: pull?.id ?? null,
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

  const handOff: HoustonMergeQueueGitHub["Service"]["handOff"] = (input) =>
    (input.mode === "mergeQueue"
      ? graphql(input.target, "houston.mergeQueue.enqueue", ENQUEUE, {
          id: input.nodeId,
          oid: input.sha,
        })
      : graphql(input.target, "houston.mergeQueue.autoMerge", ENABLE_AUTO_MERGE, {
          id: input.nodeId,
          oid: input.sha,
          method: input.method.toUpperCase(),
        })
    ).pipe(
      Effect.asVoid,
      Effect.mapError(
        (error) =>
          `GitHub refused to ${input.mode === "mergeQueue" ? "enqueue" : "enable auto-merge for"} PR #${input.number} at ${input.sha}: ${error}`,
      ),
    );

  const takeBack: HoustonMergeQueueGitHub["Service"]["takeBack"] = (input) =>
    (input.mode === "mergeQueue"
      ? graphql(input.target, "houston.mergeQueue.dequeue", DEQUEUE, { id: input.nodeId })
      : graphql(input.target, "houston.mergeQueue.disableAutoMerge", DISABLE_AUTO_MERGE, {
          id: input.nodeId,
        })
    ).pipe(
      Effect.asVoid,
      Effect.mapError(
        (error) =>
          `GitHub refused to ${input.mode === "mergeQueue" ? "take PR #" + input.number + " out of its merge queue" : "turn auto-merge off for PR #" + input.number}: ${error}`,
      ),
    );

  const retarget: HoustonMergeQueueGitHub["Service"]["retarget"] = (target, number, base) =>
    github
      .rest({
        host: target.host,
        operation: "houston.mergeQueue.retarget",
        method: "PATCH",
        path: `repos/${target.repository}/pulls/${number}`,
        body: { base },
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) => `GitHub refused to retarget PR #${number} to ${base}: ${errorText(error)}`,
        ),
      );

  const revert: HoustonMergeQueueGitHub["Service"]["revert"] = (target, number) =>
    pullRequests
      .runAction({ ...reference(target, number), action: "revert" })
      .pipe(
        Effect.mapError(
          (error) => `GitHub refused to open a revert of PR #${number}: ${errorText(error)}`,
        ),
      );

  return HoustonMergeQueueGitHub.of({
    read,
    merge,
    reportMerged,
    handOff,
    takeBack,
    retarget,
    revert,
  });
});

export const layer = Layer.effect(HoustonMergeQueueGitHub, make);
