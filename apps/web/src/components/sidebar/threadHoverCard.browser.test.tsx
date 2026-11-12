import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { render } from "../../../test/render";
import { ThreadHoverCard } from "./threadHoverCard";

const fixture = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: string; label: string }>,
  terminals: [] as string[],
  checkoutBranch: "main" as string | null,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: fixture.environments })) as never,
}));
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useThreadRunningTerminalIds: (() => fixture.terminals) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: unknown) =>
    ref === null ? null : { id: "project-1", workspaceRoot: "/repo" }) as never,
}));
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => ({})) as never },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : { refName: fixture.checkoutBranch },
  })) as never,
}));

const providerEntries = new Map([
  [
    "claude",
    { displayName: "Claude", models: [{ slug: "opus", name: "Opus 4", isCustom: false }] },
  ],
  ["codex", { displayName: "Codex", models: [] }],
]) as never;

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "t",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Fix the rail",
    branch: "feature/x",
    worktreePath: null,
    pullRequests: [],
    providerInstanceId: "claude",
    providerInstanceHistory: ["claude"],
    modelSelection: { instanceId: "claude", model: "opus" },
    runtime: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

async function card(value: EnvironmentThreadShell) {
  return render(
    <ThreadHoverCard
      thread={value}
      workspaceTitle="Houston"
      providerEntries={providerEntries}
      branchName={value.branch}
      nowMs={Date.parse("2026-01-01T00:00:00.000Z")}
    />,
    { router: false },
  );
}

describe("ThreadHoverCard", () => {
  it("shows the project, branch, provider and friendly model name", async () => {
    fixture.checkoutBranch = "feature/x";
    fixture.terminals = [];
    fixture.environments = [];
    await using screen = await card(thread());
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Fix the rail");
    expect(text).toContain("Houston");
    expect(text).toContain("feature/x · local checkout");
    expect(text).toContain("Claude · Opus 4");
    expect(text).not.toContain("Checkout is on");
  });

  it("warns when the local checkout is on another branch", async () => {
    fixture.checkoutBranch = "main";
    await using screen = await card(thread());
    expect(screen.container.textContent).toContain("Checkout is on main, not feature/x");
  });

  it("names the environment only when there are several", async () => {
    fixture.checkoutBranch = "feature/x";
    fixture.environments = [
      { environmentId: "env-1", label: "Build box" },
      { environmentId: "env-2", label: "Laptop" },
    ];
    await using several = await card(thread());
    expect(several.container.textContent).toContain("Build box");
    await several[Symbol.asyncDispose]();

    fixture.environments = [{ environmentId: "env-1", label: "Build box" }];
    await using one = await card(thread());
    expect(one.container.textContent).not.toContain("Build box");
  });

  it("lists handoffs, terminal processes, the last error and pull requests", async () => {
    fixture.checkoutBranch = "feature/x";
    fixture.environments = [];
    fixture.terminals = ["a", "b"];
    await using screen = await card(
      thread({
        providerInstanceHistory: ["claude", "codex"],
        runtime: { usageLimitResetAt: null, lastError: "Provider exited with code 1" },
        pullRequests: [{ number: 12, snapshot: { title: "Rail fixes", state: "open" } }],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Handed off: Claude → Codex");
    expect(text).toContain("2 terminal processes");
    expect(text).toContain("Provider exited with code 1");
    expect(text).toContain("#12 Rail fixes · open");
  });

  it("says a usage limit resets when it is still ahead", async () => {
    fixture.terminals = [];
    await using screen = await card(
      thread({ runtime: { usageLimitResetAt: "2026-01-01T05:00:00.000Z", lastError: null } }),
    );
    expect(screen.container.textContent).toContain("Usage limit reached. Resets");
  });
});
