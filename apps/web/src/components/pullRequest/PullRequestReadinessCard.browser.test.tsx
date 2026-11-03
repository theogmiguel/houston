import { SourceControlProviderKind } from "@houston-app/contracts";
import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { render as renderUi } from "../../../test/render";
import { PullRequestReadinessCard } from "./PullRequestReadinessCard";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Houston",
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
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [{ login: "alice", name: null, avatarUrl: null }],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [
    {
      id: "review",
      kind: "review",
      author: { login: "alice", name: null, avatarUrl: null },
      body: "",
      createdAt: "2026-09-01T01:00:00Z",
      url: null,
      path: null,
      reviewState: "CHANGES_REQUESTED",
    },
  ],
  commentCount: 1,
  commentsTruncated: false,
  reviewThreads: [
    {
      id: "thread",
      path: "src/a.ts",
      line: 4,
      side: "right",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "thread-comment",
          author: { login: "alice", name: null, avatarUrl: null },
          body: "Finding",
          createdAt: "2026-09-01T01:00:00Z",
          url: null,
        },
      ],
    },
  ],
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
};

async function render() {
  return renderUi(
    <PullRequestReadinessCard
      environmentId={EnvironmentId.make("environment")}
      threadRef={null}
      reference={{ projectId: ProjectId.make("project"), repository: detail.repository, number: 1 }}
      detail={detail}
      activityPending={false}
      checksState="passing"
      checksStale={false}
      checksSummary="1 of 1 check passed"
      canApproveWorkflows={false}
      approvingWorkflows={false}
      approveWorkflows={{ armed: false, onClick: () => {}, onBlur: () => {} }}
      onRefreshChecks={() => {}}
      pendingFinding={null}
      fixCheckLabel="Fix"
      freshness={null}
      actionPending={false}
      onUpdateBranch={() => {}}
      resolveConflicts={<button type="button">Resolve conflicts</button>}
      primary={null}
      primaryMenu={null}
    />,
  );
}

it("answers whether the pull request can merge, and why not", async () => {
  await using screen = await render();

  await expect.element(screen.getByText("All checks passed")).toBeVisible();
  await expect.element(screen.getByText("1 of 1")).toBeVisible();
  await expect.element(screen.getByText("Changes requested by alice")).toBeVisible();
  await expect.element(screen.getByText("1 unresolved thread")).toBeVisible();
  await expect.element(screen.getByText("Conflicts with main")).toBeVisible();
  const conflictsRow = [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Conflicts with main"),
  );
  if (conflictsRow === undefined) throw new Error("expected the conflicts row");
  await userEvent.click(conflictsRow);
  await expect.element(screen.getByText("Resolve conflicts")).toBeVisible();
});
