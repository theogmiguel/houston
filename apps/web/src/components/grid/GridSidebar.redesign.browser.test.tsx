import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { render } from "../../../test/render";
import { SidebarNewGridMenu } from "../ui/sidebar-grids";
import { TooltipProvider } from "../ui/tooltip";
import { GridGroup } from "./GridSidebar";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Split drawer state from the thread store",
    branch: "houston/split-drawer-state",
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
  } as unknown as EnvironmentThreadShell;
}

function grid(overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "grid-a",
    name: "v2 port",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: null,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function group(
  value: GridRecord,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: {
    workspaceTitle?: string;
    open?: boolean;
    solo?: boolean;
    onOpenThread?: (gridId: string, threadId: string) => void;
  } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <GridGroup
        grid={value}
        workspaceTitle={overrides.workspaceTitle ?? "Houston"}
        threads={threads}
        solo={overrides.solo ?? threads.length === 1}
        query=""
        open={overrides.open ?? false}
        collapsed={false}
        onToggleCollapsed={() => {}}
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        selection={clearThreadSelection()}
        runningSubagents={new Map()}
        dragging={null}
        dropTarget={null}
        hiddenGrids={[]}
        onOpenThread={overrides.onOpenThread ?? (() => {})}
        onSelectThread={() => {}}
        onCloseThread={() => {}}
        onHoldThread={() => {}}
        onPickHoldTime={async () => null}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragOverGrid={() => {}}
        onDropOnGrid={() => {}}
        onDropOnThread={() => {}}
        onDragLeave={() => {}}
        readDragged={() => null}
        onCreateThread={() => {}}
        onRenameThread={() => {}}
        onSetAutoClose={() => {}}
        onShowGrid={() => {}}
        onCreateGrid={() => {}}
      />
    </TooltipProvider>
  );
}

describe("grid sidebar", () => {
  it("lists grids flat with their workspace instead of a workspace row", async () => {
    const first = grid({ id: "grid-a", name: "v2 port" });
    const second = grid({
      id: "grid-b",
      name: "Grid 2",
      projectId: "project-2",
      workspaceKey: "env-1:project-2",
    });
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      <>
        {group(first, threads)}
        {group(second, [], { workspaceTitle: "notes" })}
      </>,
    );

    expect(screen.getByRole("button", { name: /^v2 port Houston$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^Grid 2 notes empty$/ }).element()).toBeVisible();
    expect(screen.getByText("notes").element()).toBeVisible();
    expect(screen.container.textContent).not.toContain("Workspaces");
  });

  it("renders a one-thread grid at grid level without a heading", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      group(grid({ id: "grid-c", name: "Landing copy" }), [thread({ id: "thread-c" })], {
        workspaceTitle: "houston-site",
        onOpenThread,
      }),
    );

    expect(screen.container.textContent).not.toContain("Landing copy");
    expect(screen.getByText("houston-site ·").element()).toBeVisible();
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    expect(row.className).toContain("pl-2.5");

    await userEvent.click(screen.getByText("Split drawer state from the thread store").element());
    expect(onOpenThread).toHaveBeenCalledWith("grid-c", "thread-c");
  });

  it("tints only the open grid's heading", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      <>
        {group(grid({ id: "grid-a", name: "v2 port" }), threads, { open: true })}
        {group(grid({ id: "grid-b", name: "Review" }), threads, { open: false })}
      </>,
    );

    const open = screen.getByRole("button", { name: /^v2 port Houston$/ }).element();
    const closed = screen.getByRole("button", { name: /^Review Houston$/ }).element();
    expect(open.className).toContain("bg-sidebar-row-selected");
    expect(closed.className).not.toContain("bg-sidebar-row-selected");
  });
});

describe("New grid menu", () => {
  const workspaces = [
    { key: "env-1:project-1", label: "Houston" },
    { key: "env-1:project-2", label: "houston-site" },
    { key: "env-1:project-3", label: "notes" },
  ];

  it("preselects the given workspace and creates there on Enter", async () => {
    const onSelect = vi.fn();
    await using _screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-3"
        onSelect={onSelect}
        onOpenFolder={() => {}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    const selected = page.getByRole("button", { name: "notes" }).element();
    expect(selected.getAttribute("data-selected")).toBe("");
    expect(document.activeElement).toBe(selected);

    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("env-1:project-3");
  });

  it("creates in another workspace when its row is clicked", async () => {
    const onSelect = vi.fn();
    await using _screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-1"
        onSelect={onSelect}
        onOpenFolder={() => {}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    await userEvent.click(page.getByRole("button", { name: "houston-site" }).element());
    expect(onSelect).toHaveBeenCalledWith("env-1:project-2");
  });

  it("runs the add-workspace flow from Open folder", async () => {
    const onOpenFolder = vi.fn();
    await using _screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-1"
        onSelect={() => {}}
        onOpenFolder={onOpenFolder}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    await userEvent.click(page.getByRole("button", { name: /Open folder/ }).element());
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });
});
