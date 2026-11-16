import { SourceControlProviderKind } from "@houston-app/contracts";
import type {
  PullRequestComment,
  PullRequestDetailView,
  PullRequestReviewThread,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestReadiness } from "./pullRequestReadiness.logic";

function detail(overrides: Partial<PullRequestDetailView> = {}): PullRequestDetailView {
  return {
    provider: SourceControlProviderKind.make("github"),
    workspaceRoot: "/workspace",
    repository: "owner/repo",
    number: 1,
    title: "Test pull request",
    body: "",
    url: "https://github.com/owner/repo/pull/1",
    author: { login: "author", name: null, avatarUrl: null },
    viewer: "author",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "feature",
    baseBranch: "main",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    labels: [],
    checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
    mergeCapabilities: { merge: false, squash: false, rebase: false },
    capabilities: {
      diff: true,
      comment: true,
      search: true,
      actions: [],
      mergeMethods: [],
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      reviewers: { request: false, listCandidates: false },
      edit: { changeRequest: true, comment: true },
    },
    viewerPermissions: {
      actions: [],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
    },
    ...overrides,
  } as PullRequestDetailView;
}

function review(
  login: string,
  reviewState: string,
  createdAt = "2026-09-01T01:00:00Z",
): PullRequestComment {
  return {
    id: `${login}:${reviewState}`,
    kind: "review",
    author: { login, name: null, avatarUrl: null },
    body: "",
    createdAt,
    url: null,
    path: null,
    reviewState,
  };
}

function thread(id: string, createdAt: string, isResolved = false): PullRequestReviewThread {
  return {
    id,
    path: `src/${id}.ts`,
    line: 1,
    side: "right",
    isResolved,
    isOutdated: false,
    comments: [
      {
        id: `${id}-comment`,
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "Finding",
        createdAt,
        url: null,
      },
    ],
  };
}

const base = {
  activityPending: false,
  checksStale: false,
  checksSummary: "1 of 1 check passed",
  freshness: null,
} as const;

describe("pull request readiness", () => {
  it("reads a passing rollup as all checks passed", () => {
    const readiness = pullRequestReadiness({
      ...base,
      detail: detail(),
      checksState: "passing",
    });

    expect(readiness.checksLabel).toBe("All checks passed");
    expect(readiness.checksMeta).toBe("1 of 1");
  });

  it("names who asked for changes, and counts approvals among everyone asked", () => {
    const readiness = pullRequestReadiness({
      ...base,
      detail: detail({
        reviewers: [
          { login: "alice", name: null, avatarUrl: null },
          { login: "bob", name: null, avatarUrl: null },
        ],
        comments: [
          review("alice", "CHANGES_REQUESTED"),
          review("bob", "APPROVED", "2026-09-01T02:00:00Z"),
        ],
      }),
      checksState: "passing",
    });

    expect(readiness.reviewOutcome).toBe("changes-requested");
    expect(readiness.reviewLabel).toBe("Changes requested by alice");
    expect(readiness.reviewMeta).toBe("1 of 2 approved");
  });

  it("ignores a verdict made before the latest commit", () => {
    const readiness = pullRequestReadiness({
      ...base,
      detail: detail({
        reviewers: [{ login: "alice", name: null, avatarUrl: null }],
        comments: [review("alice", "APPROVED", "2026-09-01T01:00:00Z")],
        commits: [
          {
            oid: "1234567",
            messageHeadline: "Answer the review",
            committedDate: "2026-09-01T02:00:00Z",
          },
        ],
      }),
      checksState: "passing",
    });

    expect(readiness.reviewOutcome).toBeNull();
    expect(readiness.reviewLabel).toBe("Waiting on reviews");
    expect(readiness.reviewMeta).toBe("0 of 1 approved");
  });

  it("says nobody has been asked when there are no reviewers", () => {
    const readiness = pullRequestReadiness({ ...base, detail: detail(), checksState: "passing" });

    expect(readiness.reviewLabel).toBe("No reviews yet");
    expect(readiness.reviewMeta).toBeNull();
  });

  it("counts unresolved threads oldest first", () => {
    const readiness = pullRequestReadiness({
      ...base,
      detail: detail({
        reviewThreads: [
          thread("later", "2026-09-01T03:00:00Z"),
          thread("resolved", "2026-09-01T01:00:00Z", true),
          thread("earlier", "2026-09-01T02:00:00Z"),
        ],
      }),
      checksState: "passing",
    });

    expect(readiness.unresolvedThreads.map((entry) => entry.id)).toEqual(["earlier", "later"]);
  });

  it("puts mergeability against the base branch on the conflicts row", () => {
    const conflicting = pullRequestReadiness({
      ...base,
      detail: detail({ mergeability: "conflicting" }),
      checksState: "passing",
    });
    const behind = pullRequestReadiness({
      ...base,
      detail: detail(),
      checksState: "passing",
      freshness: { behindBy: 2, methods: ["merge"] },
    });

    expect(conflicting.conflictsLabel).toBe("Conflicts with main");
    expect(behind.conflictsLabel).toBe("Behind main by 2 commits");
  });

  it("hides derived counts while the conversation is still loading", () => {
    const readiness = pullRequestReadiness({
      ...base,
      detail: detail({
        reviewers: [{ login: "alice", name: null, avatarUrl: null }],
        commits: [
          { oid: "1234567", messageHeadline: "Change", committedDate: "2026-09-01T02:00:00Z" },
        ],
      }),
      checksState: "passing",
      activityPending: true,
    });

    expect(readiness.reviewLabel).toBe("Reading reviews");
    expect(readiness.reviewMeta).toBeNull();
    expect(readiness.conflictsMeta).toBeNull();
  });
});
