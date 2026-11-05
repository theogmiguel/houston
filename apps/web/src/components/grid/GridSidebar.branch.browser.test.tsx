import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: unknown) =>
    ref === null ? null : { id: "project-1", workspaceRoot: "/repo" }) as never,
}));

const statusCwds: string[] = [];
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: ((input: { input: { cwd: string } }) => {
        statusCwds.push(input.input.cwd);
        return { cwd: input.input.cwd };
      }) as never,
    },
  };
});

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: { cwd: string } | null) => ({
    data: atom === null ? null : { refName: atom.cwd === "/repo" ? "main" : "feature/x" },
  })) as never,
}));

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Local checkout thread",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

function card(value: EnvironmentThreadShell) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId="grid-a"
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={false}
        selected={false}
        dragging={false}
        workspaceTitle="Houston"
        onOpen={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={() => {}}
        onDropOnThread={() => {}}
      />
    </TooltipProvider>
  );
}

describe("ThreadCard branch", () => {
  it("shows the project checkout's current branch for a thread without its own branch", async () => {
    await using screen = await render(card(thread()));

    await expect.element(screen.getByText("main", { exact: true })).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain("no branch");
  });

  it("reads a worktree thread's branch from its worktree", async () => {
    await using screen = await render(card(thread({ worktreePath: "/worktrees/x" })));

    await expect.element(screen.getByText("feature/x", { exact: true })).toBeInTheDocument();
    expect(statusCwds).toContain("/worktrees/x");
  });

  it("keeps the thread's recorded branch without asking the checkout", async () => {
    statusCwds.length = 0;
    await using screen = await render(card(thread({ branch: "houston/recorded" })));

    await expect.element(screen.getByText("houston/recorded", { exact: true })).toBeInTheDocument();
    expect(statusCwds).toEqual([]);
  });
});
