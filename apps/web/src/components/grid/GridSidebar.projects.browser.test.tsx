import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import type { GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { COLLAPSED_PROJECTS_STORAGE_KEY, useCollapsedKeys } from "./sidebarCollapse";
import {
  SidebarAddProjectButton,
  SidebarProjectSection,
  SidebarProjectsHeader,
} from "./GridSidebar";
import type { SidebarProjectSection as SidebarProjectSectionModel } from "./sidebarProjectSections";

type SidebarProjectSectionProps = ComponentProps<typeof SidebarProjectSection>;

const openCommandPalette = vi.fn();
vi.mock("../../commandPaletteBus", () => ({
  openCommandPalette: (input?: unknown) => openCommandPalette(input),
  isCommandPaletteOpen: () => false,
}));

const openAddProjectDialog = vi.fn();
vi.mock("../AddProjectDialog", () => ({
  openAddProjectDialog: () => openAddProjectDialog(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
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

function grid(overrides: Partial<GridRecord> = {}): GridRecord {
  return {
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
    ...overrides,
  };
}

function section(overrides: Partial<SidebarProjectSectionModel> = {}): SidebarProjectSectionModel {
  return {
    projectKey: "env-1:project-1",
    title: "Houston",
    isScratch: false,
    environmentId: "env-1",
    projectId: "project-1",
    grids: [],
    hiddenGrids: [],
    ungroupedThreads: [],
    ...overrides,
  };
}

function sectionProps(
  value: SidebarProjectSectionModel,
  overrides: Partial<SidebarProjectSectionProps> = {},
): SidebarProjectSectionProps {
  return {
    section: value,
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

function CollapsibleSections({
  sections,
  onCreateGrid,
  onCreateThread,
}: {
  sections: ReadonlyArray<SidebarProjectSectionModel>;
  onCreateGrid?: (() => void) | undefined;
  onCreateThread?: ((gridId: string) => void) | undefined;
}) {
  const collapsedProjects = useCollapsedKeys(COLLAPSED_PROJECTS_STORAGE_KEY);
  return (
    <TooltipProvider delay={0}>
      {sections.map((value) => (
        <SidebarProjectSection
          key={value.projectKey}
          {...sectionProps(value, {
            collapsed: collapsedProjects.collapsed.has(value.projectKey),
            onToggleCollapsed: () => collapsedProjects.toggle(value.projectKey),
            ...(onCreateGrid === undefined ? {} : { onCreateGrid }),
            ...(onCreateThread === undefined ? {} : { onCreateThread }),
          })}
        />
      ))}
    </TooltipProvider>
  );
}

function projectSections(): SidebarProjectSectionModel[] {
  return [
    section({
      grids: [
        {
          grid: grid({
            tree: { kind: "thread", threadId: "thread-a", id: "pane-a" },
          }),
          threads: [thread("thread-a", "project-1")],
        },
        { grid: grid({ id: "grid-b", name: "Grid 2" }), threads: [] },
      ],
      ungroupedThreads: [thread("loose", "project-1")],
    }),
    section({
      projectKey: "env-1:project-2",
      title: "notes",
      projectId: "project-2",
    }),
    section({
      projectKey: "\0no-project",
      title: "No project",
      isScratch: true,
      projectId: "scratch",
      ungroupedThreads: [thread("scratch-thread", "scratch")],
    }),
  ];
}

function resetTestState(): void {
  localStorage.clear();
  openCommandPalette.mockReset();
}

describe("project sections", () => {
  it("lists grids under their project, keeps an empty project, and puts No project last", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={projectSections()} />);

    expect(screen.getByRole("button", { name: /^Houston$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^notes$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^No project$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^Grid 1$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^Grid 2 empty$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: "New grid in notes" }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: "New grid" }).element()).toBeVisible();
    expect(screen.container.textContent).not.toContain("not in a grid");
    expect(screen.container.textContent).not.toContain("Ungrouped");
  });

  it("does not repeat the project name on a grid row", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={[projectSections()[0]!]} />);

    const heading = screen.getByRole("button", { name: /^Grid 1$/ }).element();
    expect(heading.textContent).not.toContain("Houston");
  });

  it("collapses a project and remembers it across a remount", async () => {
    resetTestState();
    const sections = projectSections();
    await using first = await render(<CollapsibleSections sections={sections} />);
    await userEvent.click(first.getByRole("button", { name: /^Houston$/ }).element());
    const label = first.getByRole("button", { name: /^Houston 2 grids$/ }).element();
    expect(label.getAttribute("aria-expanded")).toBe("false");
    expect(first.container.textContent).not.toContain("Grid 1");
    await first[Symbol.asyncDispose]();

    await using second = await render(<CollapsibleSections sections={sections} />);
    const restored = second.getByRole("button", { name: /^Houston 2 grids$/ }).element();
    expect(restored.getAttribute("aria-expanded")).toBe("false");
    expect(second.container.textContent).not.toContain("Grid 1");
  });

  it("toggles a project from Enter and Space on its label", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={[projectSections()[1]!]} />);
    const label = screen.getByRole("button", { name: /^notes$/ }).element();
    label.focus();
    expect(document.activeElement).toBe(label);

    await userEvent.keyboard("{Enter}");
    await expect.element(label).toHaveAttribute("aria-expanded", "false");

    await userEvent.keyboard(" ");
    await expect.element(label).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps both + actions inside the narrowest sidebar", async () => {
    resetTestState();
    const container = document.createElement("div");
    container.style.width = "220px";
    await using screen = await render(<CollapsibleSections sections={[projectSections()[0]!]} />, {
      container,
    });

    const boundary = container.getBoundingClientRect().right + 1;
    const newGrid = screen.getByRole("button", { name: "New grid in Houston" }).element();
    const newThread = screen.getByRole("button", { name: "New thread in Grid 2" }).element();
    for (const button of [newGrid, newThread]) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.right).toBeLessThanOrEqual(boundary);
    }
  });

  it("hides the New grid action once the pointer leaves a clicked project, and shows it on keyboard focus", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={[projectSections()[1]!]} />);
    const label = screen.getByRole("button", { name: /^notes$/ }).element();
    const action = screen.getByRole("button", { name: "New grid in notes" }).element();
    const opacity = () => Number(getComputedStyle(action).opacity);

    await userEvent.click(label);
    await userEvent.unhover(label);
    await expect.poll(opacity).toBe(0);

    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(label);
    await expect.poll(opacity).toBe(1);
  });

  it("creates a grid from the project label's action", async () => {
    resetTestState();
    const onCreateGrid = vi.fn();
    await using screen = await render(
      <CollapsibleSections sections={[projectSections()[1]!]} onCreateGrid={onCreateGrid} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New grid in notes" }).element());
    expect(onCreateGrid).toHaveBeenCalledTimes(1);
  });

  it("creates a thread from a grid row's action", async () => {
    resetTestState();
    const onCreateThread = vi.fn();
    await using _screen = await render(
      <CollapsibleSections sections={[projectSections()[0]!]} onCreateThread={onCreateThread} />,
    );

    await userEvent.click(page.getByRole("button", { name: "New thread in Grid 2" }).element());
    expect(onCreateThread).toHaveBeenCalledExactlyOnceWith("grid-b");
  });

  it("pins a scratch project's rows without offering a new grid there", async () => {
    resetTestState();
    const scratch = projectSections()[2]!;
    await using screen = await render(<CollapsibleSections sections={[scratch]} />);

    expect(screen.getByRole("button", { name: /^No project$/ }).element()).toBeVisible();
    expect(page.getByRole("button", { name: /^New grid in No project$/ }).elements()).toHaveLength(
      0,
    );
  });

  it("opens the project menu instead of the native one from a right-click and Shift+F10", async () => {
    resetTestState();
    const onOpenProjectMenu = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection {...sectionProps(projectSections()[1]!, { onOpenProjectMenu })} />
      </TooltipProvider>,
    );
    const label = screen.getByRole("button", { name: /^notes$/ }).element();
    const rect = label.getBoundingClientRect();

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 5,
      clientY: rect.top + 5,
    });
    label.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenProjectMenu).toHaveBeenLastCalledWith({ x: rect.left + 5, y: rect.top + 5 });

    label.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    expect(onOpenProjectMenu).toHaveBeenCalledTimes(2);
    expect(onOpenProjectMenu).toHaveBeenLastCalledWith({ x: rect.left, y: rect.bottom + 4 });
  });

  it("offers no project menu on the scratch section", async () => {
    resetTestState();
    const onOpenProjectMenu = vi.fn();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection {...sectionProps(projectSections()[2]!, { onOpenProjectMenu })} />
      </TooltipProvider>,
    );
    const label = screen.getByRole("button", { name: /^No project$/ }).element();
    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onOpenProjectMenu).not.toHaveBeenCalled();
  });

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

  it("draws the Projects header with view options and add project, and reveals them on focus", async () => {
    resetTestState();
    const options = {
      threadSort: "grid",
      gridSort: "created_at",
      showBranch: true,
      showPullRequest: true,
      showSubagents: true,
    } as const;
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectsHeader options={options} onChange={() => {}} onReset={() => {}} />
      </TooltipProvider>,
    );

    expect(screen.container.textContent).toContain("Projects");
    const label = getComputedStyle(screen.getByText("Projects").element());
    expect(label.textTransform).toBe("none");
    expect(label.letterSpacing).toBe("normal");
    const add = screen.getByRole("button", { name: "Add project" }).element();
    const viewOptions = screen.getByRole("button", { name: "View options" }).element();
    const actions = add.parentElement as HTMLElement;
    expect(getComputedStyle(actions).opacity).toBe("0");
    expect(actions.className).toContain("group-focus-within/section:opacity-100");

    viewOptions.focus();
    expect(viewOptions.matches(":focus-visible") || viewOptions === document.activeElement).toBe(
      true,
    );

    await userEvent.click(add);
    expect(openAddProjectDialog).toHaveBeenCalledTimes(1);

    await userEvent.click(viewOptions);
    await expect.element(page.getByText("Sort threads")).toBeVisible();
  });
});

const capturesEnabled = import.meta.env.VITE_HOUSTON_CAPTURES === "1";

function captureSections(): SidebarProjectSectionModel[] {
  return [
    section({
      grids: [
        {
          grid: grid({ tree: { kind: "thread", threadId: "thread-a", id: "pane-a" } }),
          threads: [thread("thread-a", "project-1")],
        },
        { grid: grid({ id: "grid-b", name: "Grid 2" }), threads: [] },
      ],
      ungroupedThreads: [thread("loose", "project-1")],
    }),
    section({
      projectKey: "env-1:project-2",
      title: "intranet-cdv",
      projectId: "project-2",
      grids: [
        {
          grid: grid({
            id: "grid-c",
            name: "Grid 1",
            projectId: "project-2",
            workspaceKey: "env-1:project-2",
            tree: { kind: "thread", threadId: "thread-c", id: "pane-c" },
          }),
          threads: [thread("thread-c", "project-2")],
        },
      ],
    }),
    section({
      projectKey: "env-1:project-3",
      title: "a project with a very long name that must truncate",
      projectId: "project-3",
      grids: [{ grid: grid({ id: "grid-d", name: "Grid 1" }), threads: [] }],
    }),
    section({
      projectKey: "env-1:project-4",
      title: "cdv-agentos",
      projectId: "project-4",
      grids: [
        { grid: grid({ id: "grid-e", name: "Grid 1" }), threads: [] },
        { grid: grid({ id: "grid-f", name: "Grid 3" }), threads: [] },
      ],
    }),
    section({
      projectKey: "\0no-project",
      title: "No project",
      isScratch: true,
      projectId: "scratch",
      ungroupedThreads: [thread("scratch-thread", "scratch")],
    }),
  ];
}

function captureContainer(width: number): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "flex flex-col gap-px bg-(--sidebar) p-2";
  container.style.width = `${width}px`;
  container.style.minHeight = "560px";
  return container;
}

describe.skipIf(!capturesEnabled)("project sidebar captures", () => {
  it.each([
    ["light", 360],
    ["light", 256],
    ["dark", 360],
    ["dark", 256],
  ] as const)("renders the project sections in %s at %ipx", async (appearance, width) => {
    resetTestState();
    document.documentElement.classList.toggle("dark", appearance === "dark");
    localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify(["env-1:project-4"]));
    const container = captureContainer(width);
    await using _screen = await render(<CollapsibleSections sections={captureSections()} />, {
      container,
    });

    await page.screenshot({
      element: container,
      path: `../../../../../.slice/captures/project-sidebar-${appearance}-${width}.png`,
    });
    document.documentElement.classList.remove("dark");
  });

  it.each(["light", "dark"] as const)("captures the empty rail in %s", async (appearance) => {
    resetTestState();
    document.documentElement.classList.toggle("dark", appearance === "dark");
    const container = captureContainer(360);
    await using _screen = await render(
      <p className="px-2 py-3 text-xs text-secondary-label">
        Open a project to create its first grid.
      </p>,
      { container },
    );

    await page.screenshot({
      element: container,
      path: `../../../../../.slice/captures/project-sidebar-empty-${appearance}.png`,
    });
    document.documentElement.classList.remove("dark");
  });

  it.each(["light", "dark"] as const)("captures the row tooltips in %s", async (appearance) => {
    resetTestState();
    document.documentElement.classList.toggle("dark", appearance === "dark");
    // Tooltips portal to the body; a capture should show the settled popup, not a frame of its transition.
    const motionStyle = document.createElement("style");
    motionStyle.textContent =
      '[data-slot="tooltip-positioner"], [data-slot="tooltip-popup"] { transition: none !important; }';
    document.head.append(motionStyle);
    const container = captureContainer(360);
    const screen = await render(<CollapsibleSections sections={captureSections()} />, {
      container,
    });

    await userEvent.hover(
      screen.getByRole("button", { name: "New grid in intranet-cdv" }).element(),
    );
    await expect.element(page.getByText("New grid in intranet-cdv")).toBeVisible();
    await page.screenshot({
      path: `../../../../../.slice/captures/project-sidebar-hover-project-${appearance}.png`,
    });

    await userEvent.hover(screen.getByRole("button", { name: "New thread in Grid 2" }).element());
    await expect.element(page.getByText("New thread in Grid 2")).toBeVisible();
    await page.screenshot({
      path: `../../../../../.slice/captures/project-sidebar-hover-grid-${appearance}.png`,
    });

    await screen[Symbol.asyncDispose]();
    motionStyle.remove();
    document.documentElement.classList.remove("dark");
  });
});
