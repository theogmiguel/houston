import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import type { GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { useRevealOpenThread } from "../../grid/useRevealOpenThread";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarProjectSection } from "./GridSidebar";
import type { SidebarProjectSection as SidebarProjectSectionModel } from "./sidebarProjectSections";

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

function thread(id: string): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: id,
    branch: "main",
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
  } as unknown as EnvironmentThreadShell;
}

const grid: GridRecord = {
  id: "grid-a",
  name: "Grid 1",
  environmentId: "env-1",
  projectId: "project-1",
  workspaceKey: "env-1:project-1",
  tree: null,
  focusedThreadId: null,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const section: SidebarProjectSectionModel = {
  projectKey: "env-1:project-1",
  title: "Houston",
  isScratch: false,
  environmentId: "env-1",
  projectId: "project-1",
  grids: [{ grid, threads: [thread("one"), thread("two")] }],
  hiddenGrids: [],
  ungroupedThreads: [thread("loose")],
};

function props(
  overrides: Partial<ComponentProps<typeof SidebarProjectSection>> = {},
): ComponentProps<typeof SidebarProjectSection> {
  return {
    section,
    query: "",
    openGridId: null,
    collapsed: false,
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

function tree(overrides: Partial<ComponentProps<typeof SidebarProjectSection>> = {}) {
  return (
    <TooltipProvider delay={0}>
      <div ref={attachSidebarTree}>
        <SidebarProjectSection {...props(overrides)} />
      </div>
    </TooltipProvider>
  );
}

const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(
    (row) => row.dataset.sidebarRow,
  );

describe("rail keyboard navigation", () => {
  it("lists the project, its grid, the grid's threads and the loose thread as tree rows in order", async () => {
    await using screen = await render(tree());
    expect(rowIds(screen.container)).toEqual([
      "project:env-1:project-1",
      "grid:grid-a",
      "env-1:one",
      "env-1:two",
      "env-1:loose",
    ]);
  });

  it("moves focus down and up through the rows with the arrow keys", async () => {
    await using screen = await render(tree());
    const rows = () => [...screen.container.querySelectorAll<HTMLElement>("[data-sidebar-row]")];
    rows()[0]!.focus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rows()[3]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[2]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(rows()[4]);
  });

  it("opens the focused thread row with Enter and starts renaming it with F2", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(tree({ onOpenThread }));
    const row = screen.container.querySelector<HTMLElement>("[data-sidebar-row='env-1:one']")!;
    row.focus();

    await userEvent.keyboard("{Enter}");
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("grid-a", "one");

    await userEvent.keyboard("{F2}");
    await expect.element(screen.getByRole("textbox")).toBeVisible();
  });

  it("collapses an expanded grid with ArrowLeft on its heading", async () => {
    const onToggleGridCollapsed = vi.fn();
    await using screen = await render(tree({ onToggleGridCollapsed }));
    screen.container.querySelector<HTMLElement>("[data-sidebar-row='grid:grid-a']")!.focus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(onToggleGridCollapsed).toHaveBeenCalledExactlyOnceWith("grid-a");
  });
});

function Reveal({ openKey }: { openKey: string | null }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const ref = { current: root };
  useRevealOpenThread(ref, openKey);
  return (
    <div ref={setRoot} style={{ height: 80, overflow: "auto" }} data-testid="scroller">
      {Array.from({ length: 30 }, (_, index) => (
        <div key={index} data-thread-key={`env:t${index}`} style={{ height: 30 }}>
          {index}
        </div>
      ))}
    </div>
  );
}

describe("useRevealOpenThread", () => {
  it("scrolls the open thread's row into view when the open thread changes", async () => {
    await using screen = await render(<Reveal openKey="env:t0" />, { router: false });
    const scroller = screen.container.querySelector<HTMLElement>("[data-testid='scroller']")!;
    expect(scroller.scrollTop).toBe(0);

    await screen.rerender(<Reveal openKey="env:t25" />);
    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(300);
  });

  it("leaves the scroll alone when no thread is open or the row is not rendered", async () => {
    await using screen = await render(<Reveal openKey={null} />, { router: false });
    const scroller = screen.container.querySelector<HTMLElement>("[data-testid='scroller']")!;
    await screen.rerender(<Reveal openKey="env:missing" />);
    expect(scroller.scrollTop).toBe(0);
  });
});
