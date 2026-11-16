import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarWorkspaceGroup } from "./ThreadSidebar";
import type { SidebarWorkspaceSection } from "./sidebarWorkspaceSections";

vi.mock("../../commandPaletteBus", () => ({
  openCommandPalette: () => {},
  isCommandPaletteOpen: () => false,
}));
vi.mock("../AddProjectDialog", () => ({ openAddProjectDialog: () => {} }));
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
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: id,
    branch: "main",
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
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    tags: [],
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function group(
  threads: EnvironmentThreadShell[],
  overrides: Partial<ComponentProps<typeof SidebarWorkspaceGroup>> = {},
) {
  const section: SidebarWorkspaceSection = {
    workspaceId: "ws-1",
    name: "Research",
    pinned: false,
    hidden: false,
    empty: threads.length === 0,
    threads,
    needsYouThreads: [],
  };
  return (
    <TooltipProvider delay={0}>
      <SidebarWorkspaceGroup
        section={section}
        query=""
        open={false}
        collapsed
        onToggleCollapsed={() => {}}
        previousWorkspaceId={null}
        nextWorkspaceId={null}
        hiddenWorkspaces={[]}
        focusedThreadKey={null}
        providerEntriesByEnvironment={new Map()}
        projectTitleOf={() => "Houston"}
        nowIso="2026-01-01T00:00:00.000Z"
        selection={clearThreadSelection()}
        runningSubagents={new Map()}
        dragging={null}
        reorder={{ drag: null, begin: () => {} }}
        onOpenThread={() => {}}
        onSelectThread={() => {}}
        onCloseThread={() => {}}
        onHoldThread={() => {}}
        onPickHoldTime={async () => null}
        onDropOnWorkspace={() => {}}
        onCreateWorkspace={() => {}}
        onRenameThread={() => {}}
        onSetAutoClose={() => {}}
        workspaceMoveFor={() => undefined}
        {...overrides}
      />
    </TooltipProvider>
  );
}

const needsYou = () => thread("asks", { hasPendingUserInput: true });
const running = () => thread("busy", { runtime: { status: "running" } as never });

describe("heading count", () => {
  it("shows the thread count and an amber dot on a collapsed workspace whose threads need the user", async () => {
    await using screen = await render(group([running(), needsYou(), thread("idle")]));
    const label = screen.getByRole("button", { name: /^Research/ }).element();
    expect(label.querySelector("[data-heading-count]")?.textContent).toBe("3");
    expect(label.querySelector("[data-needs-you-dot]")).not.toBeNull();
    expect(screen.container.querySelector("[data-attention-pip]")).toBeNull();
    expect(screen.container.textContent).not.toContain("busy");
  });

  it("shows no count, dot or pip on an expanded workspace with a failed thread and threads that need the user", async () => {
    const failed = thread("broke", {
      latestRun: {
        id: "run-broke",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
      } as never,
      runtime: { status: "failed", lastErrorClass: "provider_error" } as never,
    });
    await using screen = await render(
      group([failed, needsYou(), thread("asks-too", { hasPendingApprovals: true })], {
        collapsed: false,
      }),
    );
    const label = screen.getByRole("button", { name: /^Research/ }).element();
    expect(label.querySelector("[data-heading-count]")).toBeNull();
    expect(label.querySelector("[data-needs-you-dot]")).toBeNull();
    expect(screen.container.querySelector("[data-attention-pip]")).toBeNull();
  });

  it("keeps the open thread's row under a collapsed workspace and counts it with the rest", async () => {
    await using screen = await render(
      group([thread("open-one"), thread("other")], {
        open: true,
        focusedThreadKey: "env-1:open-one",
      }),
    );
    expect(screen.container.querySelector("[data-thread-key$='open-one']")).not.toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':other']")).toBeNull();
    expect(screen.getByRole("button", { name: /^Research 2$/ }).element()).toBeVisible();
  });

  it("shows no thread row under a collapsed workspace when none of its threads is open", async () => {
    await using screen = await render(group([thread("a")]));
    expect(screen.container.querySelector("[data-thread-key]")).toBeNull();
  });

  it("keeps a collapsed workspace's open thread visible and hides the one that needs the user", async () => {
    await using screen = await render(
      group([thread("a"), needsYou()], { open: true, focusedThreadKey: "env-1:a" }),
    );
    const heading = screen.getByRole("button", { name: /^Research/ }).element();
    expect(heading.querySelector("[data-heading-count]")?.textContent).toBe("2");
    expect(screen.container.querySelector("[data-attention-pip]")).toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':a']")).not.toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':asks']")).toBeNull();
  });
});
