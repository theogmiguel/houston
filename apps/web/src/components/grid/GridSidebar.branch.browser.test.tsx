import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { endThreadDrag, getThreadDragSource } from "../../grid/threadDrag";
import { ThreadCard } from "./GridSidebar";
import { SidebarSearchHighlightContext } from "./sidebarSearchResults";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: unknown) =>
    ref === null ? null : { id: "project-1", workspaceRoot: "/repo" }) as never,
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
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

  it("keeps the thread's recorded branch over the checkout's current one", async () => {
    await using screen = await render(card(thread({ branch: "houston/recorded" })));

    await expect.element(screen.getByText("houston/recorded", { exact: true })).toBeInTheDocument();
    expect(screen.container.textContent).not.toContain("main");
  });
});

describe("ThreadCard search highlight", () => {
  it("marks the row that Enter would open and no other", async () => {
    const key = scopedThreadKey(scopeThreadRef("env-1" as never, "thread-a" as never));
    await using highlighted = await render(
      <SidebarSearchHighlightContext.Provider value={key}>
        {card(thread())}
      </SidebarSearchHighlightContext.Provider>,
    );
    expect(highlighted.container.querySelector("[data-search-highlighted]")).not.toBeNull();
    await highlighted[Symbol.asyncDispose]();

    await using other = await render(
      <SidebarSearchHighlightContext.Provider value="env-1:other">
        {card(thread())}
      </SidebarSearchHighlightContext.Provider>,
    );
    expect(other.container.querySelector("[data-search-highlighted]")).toBeNull();
  });
});

describe("ThreadCard shelf row drag", () => {
  it("starts a drag from a Closed row that carries the thread, so it can return to the rail", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <ThreadCard
          gridId={null}
          thread={thread({ settledOverride: "settled" })}
          query=""
          providerEntries={new Map()}
          nowIso="2026-01-01T00:00:00.000Z"
          focused={false}
          selected={false}
          dragging={false}
          workspaceTitle="Houston"
          shelf="settled"
          onOpen={() => {}}
          onSelect={() => {}}
          onClose={() => {}}
          onHold={() => {}}
          onPickHoldTime={async () => null}
          onRename={() => {}}
          onSetAutoClose={() => {}}
          onDropOnThread={() => {}}
        />
      </TooltipProvider>,
    );
    const handle = screen.container.querySelector<HTMLElement>("[data-card-open]")!;
    const rect = handle.getBoundingClientRect();
    const at = (type: string, dx: number) =>
      (type === "pointerdown" ? handle : window).dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 3,
          button: 0,
          pointerType: "mouse",
          clientX: rect.left + 4 + dx,
          clientY: rect.top + 4,
        }),
      );
    at("pointerdown", 0);
    at("pointermove", 30);
    try {
      expect(getThreadDragSource()).toMatchObject({
        gridId: null,
        threadId: "thread-a",
        title: "Local checkout thread",
      });
    } finally {
      endThreadDrag();
    }
  });
});
