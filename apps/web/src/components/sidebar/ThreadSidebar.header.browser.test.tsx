import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { TooltipProvider } from "../ui/tooltip";
import { COLLAPSED_WORKSPACES_STORAGE_KEY, useCollapsedKeys } from "./sidebarCollapse";
import {
  SidebarAddProjectButton,
  SidebarToolbarActions,
  SidebarWorkspaceGroup,
  SidebarWorkspacesHeader,
} from "./ThreadSidebar";
import type { SidebarWorkspaceSection } from "./sidebarWorkspaceSections";

const openCommandPalette = vi.fn();
vi.mock(import("../../commandPaletteBus"), async (original) => ({
  ...(await original()),
  openCommandPalette: ((detail: unknown) => openCommandPalette(detail)) as never,
}));

const openAddProjectDialog = vi.fn();
vi.mock("../AddProjectDialog", () => ({
  openAddProjectDialog: () => openAddProjectDialog(),
}));

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

function thread(
  id: string,
  projectId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId,
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
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function section(
  id: string,
  name: string,
  threads: EnvironmentThreadShell[],
): SidebarWorkspaceSection {
  return {
    workspaceId: id,
    name,
    pinned: false,
    hidden: false,
    empty: threads.length === 0,
    threads,
    needsYouThreads: [],
  };
}

function groupProps(
  value: SidebarWorkspaceSection,
  overrides: Partial<ComponentProps<typeof SidebarWorkspaceGroup>> = {},
): ComponentProps<typeof SidebarWorkspaceGroup> {
  return {
    section: value,
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

/** The groups as the rail wires them: collapse state persisted, and a search opens every group. */
function CollapsibleSections({
  sections,
  query = "",
}: {
  sections: ReadonlyArray<SidebarWorkspaceSection>;
  query?: string;
}) {
  const collapsed = useCollapsedKeys(COLLAPSED_WORKSPACES_STORAGE_KEY);
  return (
    <TooltipProvider delay={0}>
      {sections.map((value) => (
        <SidebarWorkspaceGroup
          key={value.workspaceId}
          {...groupProps(value, {
            query,
            collapsed: query.length === 0 && collapsed.collapsed.has(value.workspaceId),
            onToggleCollapsed: () => collapsed.toggle(value.workspaceId),
          })}
        />
      ))}
    </TooltipProvider>
  );
}

function workspaceSections(): SidebarWorkspaceSection[] {
  return [
    section("ws-1", "Research", [thread("thread-a", "project-1"), thread("thread-b", "project-2")]),
    section("ws-2", "Review", []),
  ];
}

const options = {
  threadSort: "grid",
  showBranch: true,
  showPullRequest: true,
  showSubagents: true,
  showNeedsYou: false,
} as const;

function resetTestState(): void {
  localStorage.clear();
  openAddProjectDialog.mockReset();
}

describe("workspace groups on the rail", () => {
  it("collapses a workspace and remembers it across a remount", async () => {
    resetTestState();
    const sections = workspaceSections();
    await using first = await render(<CollapsibleSections sections={sections} />);
    await userEvent.click(first.getByRole("button", { name: /^Research$/ }).element());
    const label = first.getByRole("button", { name: /^Research 2$/ }).element();
    expect(label.getAttribute("aria-expanded")).toBe("false");
    expect(first.container.querySelector("[data-thread-key]")).toBeNull();
    await first[Symbol.asyncDispose]();

    await using second = await render(<CollapsibleSections sections={sections} />);
    const restored = second.getByRole("button", { name: /^Research 2$/ }).element();
    expect(restored.getAttribute("aria-expanded")).toBe("false");
    expect(second.container.querySelector("[data-thread-key]")).toBeNull();
  });

  it("expands a collapsed workspace while a search is active so its matches show", async () => {
    resetTestState();
    localStorage.setItem(COLLAPSED_WORKSPACES_STORAGE_KEY, JSON.stringify(["ws-1"]));
    await using screen = await render(
      <CollapsibleSections sections={workspaceSections()} query="thread-a" />,
    );
    expect(
      screen
        .getByRole("button", { name: /^Research$/ })
        .element()
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.container.querySelector("[data-thread-key$=':thread-a']")).not.toBeNull();
  });

  it("keeps a collapsed workspace collapsed without a search", async () => {
    resetTestState();
    localStorage.setItem(COLLAPSED_WORKSPACES_STORAGE_KEY, JSON.stringify(["ws-1"]));
    await using screen = await render(<CollapsibleSections sections={workspaceSections()} />);
    expect(screen.container.querySelector("[data-thread-key]")).toBeNull();
  });

  it("keeps both heading actions inside the narrowest sidebar", async () => {
    resetTestState();
    const container = document.createElement("div");
    container.style.width = "220px";
    await using screen = await render(<CollapsibleSections sections={workspaceSections()} />, {
      container,
    });

    const boundary = container.getBoundingClientRect().right + 1;
    const newThread = screen.getByRole("button", { name: "New thread in Research" }).element();
    const actions = screen
      .getByRole("button", { name: "Workspace actions for Research" })
      .element();
    for (const button of [newThread, actions]) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.right).toBeLessThanOrEqual(boundary);
    }
  });
});

describe("Workspaces header", () => {
  it("opens the add-project dialog from the header button", async () => {
    resetTestState();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarAddProjectButton />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    expect(openAddProjectDialog).toHaveBeenCalledTimes(1);
  });

  it("draws a quiet Workspaces label whose actions show on hover or focus", async () => {
    resetTestState();
    const hidden = { ...section("ws-hidden", "Archive", []), hidden: true };
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarWorkspacesHeader hiddenWorkspaces={[hidden]} />
      </TooltipProvider>,
    );

    const label = getComputedStyle(screen.getByText("Workspaces").element());
    expect(label.textTransform).toBe("none");
    expect(label.letterSpacing).toBe("normal");
    const hiddenMenu = screen.getByRole("button", { name: "Hidden workspaces" }).element();
    const actions = hiddenMenu.parentElement as HTMLElement;
    expect(getComputedStyle(actions).opacity).toBe("0");
    expect(actions.className).toContain("group-focus-within/section:opacity-100");
  });

  it("puts new thread, add project and view options beside the search, with New workspace in the options menu", async () => {
    resetTestState();
    const onNewWorkspace = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div className="flex">
          <SidebarToolbarActions
            options={options}
            onChange={() => {}}
            onReset={() => {}}
            onNewWorkspace={onNewWorkspace}
          />
        </div>
      </TooltipProvider>,
    );

    const names = ["New thread", "Add project", "View options"];
    const boxes = names.map((name) =>
      screen.getByRole("button", { name }).element().getBoundingClientRect(),
    );
    for (const box of boxes) {
      expect(box.width).toBe(28);
      expect(box.height).toBe(28);
      expect(box.top).toBe(boxes[0]!.top);
    }
    expect(screen.getByRole("button", { name: "New workspace" }).elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    expect(openAddProjectDialog).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "View options" }).element());
    await expect.element(page.getByText("Sort threads")).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }).element());
    expect(onNewWorkspace).toHaveBeenCalledTimes(1);
  });

  it("starts a thread from the toolbar in a new tab of the focused pane", async () => {
    resetTestState();
    openCommandPalette.mockClear();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarToolbarActions
          options={options}
          onChange={() => {}}
          onReset={() => {}}
          onNewWorkspace={() => {}}
        />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "New thread" }).element());
    expect(openCommandPalette).toHaveBeenCalledWith({ open: "new-thread-in", newTab: true });
  });

  it("lists hidden workspaces and shows one again in the layout store", async () => {
    resetTestState();
    const hidden = { ...section("ws-hidden", "Archive", []), hidden: true };
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarWorkspacesHeader hiddenWorkspaces={[hidden]} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Hidden workspaces" }).element());
    await expect.element(page.getByRole("menuitem", { name: /Archive/ })).toBeVisible();
  });

  it("omits the hidden-workspaces menu when none is hidden", async () => {
    resetTestState();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarWorkspacesHeader />
      </TooltipProvider>,
    );
    expect(screen.container.querySelector("[aria-label='Hidden workspaces']")).toBeNull();
  });
});
