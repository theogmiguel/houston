import { SourceControlProviderKind } from "@houston-app/contracts";
import { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render as renderUi } from "../../../test/render";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestStackGroup } from "./PullRequestStackGroup";

function layer(
  number: number,
  position: number,
  overrides: Partial<EnvironmentPullRequestEntry> = {},
): EnvironmentPullRequestEntry {
  return {
    environmentId: EnvironmentId.make("environment"),
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project"),
    projectTitle: "Houston",
    repository: "owner/repo",
    number,
    title: `Layer ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `layer-${number}`,
    baseBranch: number === 1 ? "main" : `layer-${number - 1}`,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 2,
    deletions: 1,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    checksState: "passing",
    stack: { number: 7, position, size: 2, base: "main" },
    ...overrides,
  };
}

it("folds a stack and speaks for its worst layer", async () => {
  const entries = [layer(1, 1), layer(2, 2, { checksState: "failing" })];
  const screen = await renderUi(
    <PullRequestStackGroup
      entries={entries}
      isSelected={() => false}
      rowProps={(entry) => ({
        statsKey: String(entry.number),
        statsRef: () => {},
        showProjectTitle: true,
        showProvider: false,
        matchedElsewhere: false,
        queuePosition: null,
        onSelect: () => {},
        hostActions: new Set(),
        onActed: () => {},
        closing: false,
        sweeping: false,
        onCloseSweepStart: () => {},
      })}
    />,
  );

  await expect.element(screen.getByText("Checks failing")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Stack of 2 pull requests from #1" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Layer 1")).toBeVisible();
  await expect.element(screen.getByText("Layer 2")).not.toBeInTheDocument();

  const summary = [...screen.container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Stack of 2 pull requests from #1",
  );
  if (summary === undefined) throw new Error("expected the stack summary");
  await userEvent.click(summary);
  await expect.element(screen.getByText("Layer 2")).toBeVisible();
});
