import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import type { GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarProjectSection } from "./GridSidebar";
import type { SidebarProjectSection as SidebarProjectSectionModel } from "./sidebarProjectSections";

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

function grid(id: string, focusedThreadId: string | null): GridRecord {
  return {
    id,
    name: id,
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: null,
    focusedThreadId,
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function props(
  section: SidebarProjectSectionModel,
  overrides: Partial<ComponentProps<typeof SidebarProjectSection>> = {},
): ComponentProps<typeof SidebarProjectSection> {
  return {
    section,
    query: "",
    openGridId: null,
    collapsed: true,
    onToggleCollapsed: () => {},
    collapsedGridIds: new Set(),
    onToggleGridCollapsed: () => {},
    providerEntries: new Map(),
    nowIso: "2026-01-01T00:00:00.000Z",
    selection: clearThreadSelection(),
    runningSubagents: new Map(),
    dragging: null,
    dropTarget: null,
    onOpenThread: () => {},
    onSelectThread: () => {},
    onCloseThread: () => {},
    onHoldThread: () => {},
    onPickHoldTime: async () => null,
    onDropOnGrid: () => {},
    onDropOnThread: () => {},
    onCreateGrid: () => {},
    onCreateThread: () => {},
    onRenameThread: () => {},
    onSetAutoClose: () => {},
    onShowGrid: () => {},
    onOpenUngroupedThread: () => {},
    ...overrides,
  };
}

function section(
  grids: SidebarProjectSectionModel["grids"],
  ungroupedThreads: EnvironmentThreadShell[] = [],
): SidebarProjectSectionModel {
  return {
    projectKey: "env-1:project-1",
    title: "Houston",
    isScratch: false,
    environmentId: "env-1",
    projectId: "project-1",
    grids,
    hiddenGrids: [],
    ungroupedThreads,
  };
}

const needsYou = () => thread("asks", { hasPendingUserInput: true });
const running = () => thread("busy", { runtime: { status: "running" } as never });

describe("heading count", () => {
  it("shows the thread count and no pip on a collapsed project whose threads need the user", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...props(
            section(
              [{ grid: grid("g1", null), threads: [running(), needsYou()] }],
              [thread("idle")],
            ),
          )}
        />
      </TooltipProvider>,
    );
    const label = screen.getByRole("button", { name: /^Houston/ }).element();
    expect(label.querySelector("[data-heading-count]")?.textContent).toBe("3");
    expect(screen.container.querySelector("[data-attention-pips]")).toBeNull();
    expect(screen.container.querySelector("[data-attention-pip]")).toBeNull();
    expect(screen.container.textContent).not.toContain("busy");
  });

  it("shows no pip on an expanded project with a failed thread and threads that need the user", async () => {
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
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...props(
            section([
              {
                grid: grid("g1", null),
                threads: [failed, needsYou(), thread("asks-too", { hasPendingApprovals: true })],
              },
            ]),
            { collapsed: false },
          )}
        />
      </TooltipProvider>,
    );
    const label = screen.getByRole("button", { name: /^Houston/ }).element();
    expect(label.querySelector("[data-heading-count]")?.textContent).toBe("3");
    expect(screen.container.querySelector("[data-attention-pip]")).toBeNull();
    expect(screen.container.querySelector("[data-attention-pips]")).toBeNull();
  });

  it("keeps the open thread's row under a collapsed project and counts it with the rest", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...props(
            section([
              { grid: grid("g1", "open-one"), threads: [thread("open-one"), thread("other")] },
            ]),
            { openGridId: "g1" },
          )}
        />
      </TooltipProvider>,
    );
    expect(screen.container.querySelector("[data-thread-key$='open-one']")).not.toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':other']")).toBeNull();
    expect(screen.getByRole("button", { name: /^Houston 2$/ }).element()).toBeVisible();
  });

  it("shows no thread row under a collapsed project when no grid is open", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...props(section([{ grid: grid("g1", "a"), threads: [thread("a")] }]))}
        />
      </TooltipProvider>,
    );
    expect(screen.container.querySelector("[data-thread-key]")).toBeNull();
  });

  it("counts a collapsed grid without a pip and keeps its open thread visible", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...props(section([{ grid: grid("g1", "a"), threads: [thread("a"), needsYou()] }]), {
            collapsed: false,
            openGridId: "g1",
            collapsedGridIds: new Set(["g1"]),
          })}
        />
      </TooltipProvider>,
    );
    const heading = screen.getByRole("button", { name: /^g1/ }).element();
    const gridRow = heading.closest<HTMLElement>("[data-grid-key]")!;
    expect(heading.querySelector("[data-heading-count]")?.textContent).toBe("2");
    expect(gridRow.querySelector("[data-attention-pip]")).toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':a']")).not.toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':asks']")).toBeNull();
  });
});
