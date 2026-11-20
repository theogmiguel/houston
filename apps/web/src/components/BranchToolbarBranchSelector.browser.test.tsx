import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type VcsRef,
} from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  runtimeStatus: "running" as "running" | "idle",
}));

const REFS: VcsRef[] = [
  { name: "main", current: true, isDefault: true, worktreePath: null, isRemote: false },
  {
    name: "feature",
    current: false,
    isDefault: false,
    worktreePath: "/repo/.houston/worktrees/feature",
    isRemote: false,
  },
];

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => ({
    id: ProjectId.make("project-1"),
    workspaceRoot: "/repo",
  })) as never,
  useQuietThreadShell: (() => ({
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-1"),
    branch: "main",
    worktreePath: null,
    runtime: {
      status: mocks.runtimeStatus,
      activeRunId: mocks.runtimeStatus === "running" ? RunId.make("run-1") : null,
    },
    linkedPullRequest: null,
    pullRequests: [],
    branchPullRequest: null,
    issues: [],
  })) as never,
}));

vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: null, refresh: () => {} })) as never,
}));

vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  usePaginatedBranches: () => ({
    data: {
      refs: REFS,
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: REFS.length,
    },
    refs: REFS,
    error: null,
    isPending: false,
    isFetchingNextPage: false,
    refresh: () => {},
    loadNext: () => {},
  }),
}));

vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) => async () => {
    mocks.calls.push(command.label);
    if (command.label.endsWith("switch-ref")) {
      return { _tag: "Success", value: { refName: "feature" } };
    }
    return { _tag: "Success", value: {} };
  }) as never,
}));

vi.mock(import("../hooks/useSupportsMultiplePullRequests"), () => ({
  useSupportsMultiplePullRequests: () => false,
}));

vi.mock(import("../lib/openPullRequestLink"), () => ({
  useOpenPrLink: (() => () => false) as never,
}));

vi.mock(import("./ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: (() => null) as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

function view() {
  return (
    <BranchToolbarBranchSelector
      environmentId={EnvironmentId.make("environment-local")}
      threadId={ThreadId.make("thread-1")}
      envLocked
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
    />
  );
}

describe("BranchToolbarBranchSelector", () => {
  it("disables the branch control with a visible reason while a turn runs", async () => {
    mocks.runtimeStatus = "running";
    await using _screen = await render(view());
    const trigger = page.getByRole("combobox");
    await expect.element(trigger).toBeDisabled();
    await expect.element(page.getByText("Turn running", { exact: true })).toBeVisible();
    await userEvent.hover(trigger.element());
    await expect
      .element(page.getByText("Stop the running turn to switch branches.", { exact: true }))
      .toBeVisible();
    await userEvent.click(trigger.element());
    await expect.element(page.getByPlaceholder("Search refs...")).not.toBeInTheDocument();
  });

  it("never stops the provider session when choosing a branch", async () => {
    mocks.runtimeStatus = "idle";
    mocks.calls = [];
    await using _screen = await render(view());
    await userEvent.click(page.getByRole("combobox").element());
    await userEvent.click(page.getByRole("option", { name: "feature", exact: true }).element());
    expect(mocks.calls.some((label) => label.endsWith("stop-session"))).toBe(false);
  });
});
