import { useEffect, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { useRevealOpenThread } from "../../threads/useRevealOpenThread";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { AnimatedHeight } from "../AnimatedHeight";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarWorkspaceGroup } from "./ThreadSidebar";
import type { SidebarWorkspaceSection } from "./sidebarWorkspaceSections";

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

const section: SidebarWorkspaceSection = {
  workspaceId: "ws-a",
  name: "Workspace 1",
  pinned: false,
  hidden: false,
  empty: false,
  threads: [thread("one"), thread("two"), thread("loose")],
  needsYouThreads: [],
};

function props(
  overrides: Partial<ComponentProps<typeof SidebarWorkspaceGroup>> = {},
): ComponentProps<typeof SidebarWorkspaceGroup> {
  return {
    section,
    query: "",
    open: false,
    collapsed: false,
    onToggleCollapsed: () => {},
    previousWorkspaceId: null,
    nextWorkspaceId: null,
    hiddenWorkspaces: [],
    focusedThreadKey: null,
    providerEntriesByEnvironment: new Map(),
    projectTitleOf: () => "Houston",
    nowIso: "2026-01-01T00:00:00.000Z",
    selection: clearThreadSelection(),
    runningSubagents: new Map(),
    dragging: null,
    dropTarget: null,
    reorder: { drag: null, begin: () => {} },
    onOpenThread: () => {},
    onSelectThread: () => {},
    onCloseThread: () => {},
    onHoldThread: () => {},
    onPickHoldTime: async () => null,
    onDropOnWorkspace: () => {},
    onCreateWorkspace: () => {},
    onRenameThread: () => {},
    onSetAutoClose: () => {},
    workspaceMoveFor: () => undefined,
    ...overrides,
  };
}

function tree(overrides: Partial<ComponentProps<typeof SidebarWorkspaceGroup>> = {}) {
  return (
    <TooltipProvider delay={0}>
      <div ref={attachSidebarTree}>
        <SidebarWorkspaceGroup {...props(overrides)} />
      </div>
    </TooltipProvider>
  );
}

const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map(
    (row) => row.dataset.sidebarRow,
  );

describe("rail keyboard navigation", () => {
  it("lists the workspace and its threads as tree rows in order", async () => {
    await using screen = await render(tree());
    expect(rowIds(screen.container)).toEqual([
      "workspace:ws-a",
      "env-1:one",
      "env-1:two",
      "env-1:loose",
    ]);
  });

  it("moves focus down and up through the rows with the arrow keys", async () => {
    await using screen = await render(tree());
    const rows = () => [...screen.container.querySelectorAll<HTMLElement>("[data-sidebar-row]")];
    rows()[0]!.focus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rows()[2]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[1]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(rows()[3]);
  });

  it("opens the focused thread row with Enter and starts renaming it with F2", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(tree({ onOpenThread }));
    const row = screen.container.querySelector<HTMLElement>("[data-sidebar-row='env-1:one']")!;
    row.focus();

    await userEvent.keyboard("{Enter}");
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "one" }));

    await userEvent.keyboard("{F2}");
    await expect.element(screen.getByRole("textbox")).toBeVisible();
  });

  it("collapses an expanded workspace with ArrowLeft on its heading", async () => {
    const onToggleCollapsed = vi.fn();
    await using screen = await render(tree({ onToggleCollapsed }));
    screen.container.querySelector<HTMLElement>("[data-sidebar-row='workspace:ws-a']")!.focus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
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

/**
 * A rail whose first section loads after the open thread's row exists: its height animates open
 * (AnimatedHeight) and pushes the second section, which holds the open thread, down the scroller.
 */
function GrowingRail({ openKey }: { openKey: string }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [firstRows, setFirstRows] = useState(1);
  const ref = { current: root };
  useRevealOpenThread(ref, openKey);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the fixture grows its first section once, after mount
    setFirstRows(12);
  }, []);
  return (
    <div ref={setRoot} style={{ height: 120, overflow: "auto" }} data-testid="scroller">
      <AnimatedHeight>
        {Array.from({ length: firstRows }, (_, index) => (
          <div key={index} data-thread-key={`env:first-${index}`} style={{ height: 40 }}>
            first {index}
          </div>
        ))}
      </AnimatedHeight>
      <AnimatedHeight>
        <div data-thread-key="env:open" style={{ height: 40 }}>
          open
        </div>
      </AnimatedHeight>
    </div>
  );
}

describe("useRevealOpenThread while the rail is still growing", () => {
  it("keeps the open thread's row in view after the sections above it finish opening", async () => {
    await using screen = await render(<GrowingRail openKey="env:open" />, { router: false });
    const scroller = screen.container.querySelector<HTMLElement>("[data-testid='scroller']")!;
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key='env:open']")!;
    // The first section has finished opening once the scroller holds all of its 12 rows.
    await expect.poll(() => row.offsetTop).toBeGreaterThanOrEqual(12 * 40);
    await expect
      .poll(() => {
        const rect = row.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        return rect.top >= view.top && rect.bottom <= view.bottom;
      })
      .toBe(true);
  });
});
