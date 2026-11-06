import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";

import { render } from "../../../test/render";
import type { GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { COLLAPSED_PROJECTS_STORAGE_KEY, useCollapsedKeys } from "./sidebarCollapse";
import { SidebarProjectSection } from "./GridSidebar";
import type { SidebarProjectSection as SidebarProjectSectionModel } from "./sidebarProjectSections";

type SidebarProjectSectionProps = ComponentProps<typeof SidebarProjectSection>;

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

function resetTestState(): void {
  localStorage.clear();
}

const manyThreads = (count: number) =>
  Array.from({ length: count }, (_, index) => thread(`thread-${index}`, "project-1"));

function failedThread(id: string): EnvironmentThreadShell {
  return thread(id, "project-1", {
    latestRun: {
      id: `run-${id}`,
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    },
    runtime: { status: "failed", lastErrorClass: "provider" },
  } as never);
}

function waitingThread(id: string): EnvironmentThreadShell {
  return thread(id, "project-1", { hasPendingApprovals: true } as never);
}

function projectWithGrid(): SidebarProjectSectionModel {
  return section({
    grids: [
      {
        grid: grid({ tree: { kind: "thread", threadId: "thread-a", id: "pane-a" } }),
        threads: [thread("thread-a", "project-1"), failedThread("thread-b")],
      },
    ],
    ungroupedThreads: [failedThread("thread-c"), waitingThread("thread-d")],
  });
}

function heading(screen: { container: HTMLElement }, title: string): HTMLElement {
  const match = [...screen.container.querySelectorAll<HTMLElement>("button[aria-expanded]")].find(
    (button) => button.textContent?.startsWith(title),
  );
  if (match === undefined) throw new Error(`No heading starts with "${title}".`);
  return match;
}

describe("project and grid headings", () => {
  it("sets the project name at 12px/600 with a chevron, a muted count and the attention pips", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={[projectWithGrid()]} />);

    const button = heading(screen, "Houston");
    const name = button.querySelector<HTMLElement>("span.truncate")!;
    expect(getComputedStyle(name).fontSize).toBe("12px");
    expect(getComputedStyle(name).fontWeight).toBe("600");
    expect(button.querySelector("[data-project-chevron-box] svg")).not.toBeNull();

    const count = button.querySelector<HTMLElement>("[data-heading-count]")!;
    expect(count.textContent).toBe("4");
    expect(getComputedStyle(count).color).not.toBe(getComputedStyle(name).color);

    const pips = button.querySelector<HTMLElement>("[data-attention-pips]")!;
    expect(pips.querySelector("[data-attention-pip='failed']")?.textContent).toBe("2");
    expect(pips.querySelector("[data-attention-pip='needs-you']")?.textContent).toBe("1");
    expect(screen.getByRole("img", { name: "2 threads failed" }).element()).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "1 thread needs you" }).element()).toBeInTheDocument();
    expect(
      Math.abs(pips.getBoundingClientRect().right - button.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(9);
  });

  it("shows neither a count nor pips on an empty project", async () => {
    resetTestState();
    await using screen = await render(
      <CollapsibleSections sections={[section({ title: "notes" })]} />,
    );
    const button = heading(screen, "notes");
    expect(button.querySelector("[data-heading-count]")).toBeNull();
    expect(button.querySelector("[data-attention-pips]")).toBeNull();
  });

  it("hides the plus at rest and shows it on hover and on keyboard focus", async () => {
    resetTestState();
    const onCreateThread = vi.fn();
    const handleNewThread = vi.fn(async () => null);
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProjectSection
          {...sectionProps(projectWithGrid(), { onCreateThread })}
          handleNewThread={handleNewThread}
        />
      </TooltipProvider>,
    );

    const plus = screen.getByRole("button", { name: "New thread in Houston" }).element();
    expect(getComputedStyle(plus).opacity).toBe("0");

    const button = heading(screen, "Houston");
    await userEvent.hover(button);
    await vi.waitFor(() => expect(getComputedStyle(plus).opacity).toBe("1"));
    const pips = button.querySelector<HTMLElement>("[data-attention-pips]")!;
    await vi.waitFor(() => expect(getComputedStyle(pips).opacity).toBe("0"));

    await userEvent.unhover(button);
    await vi.waitFor(() => expect(getComputedStyle(plus).opacity).toBe("0"));
    plus.focus();
    await vi.waitFor(() => expect(getComputedStyle(plus).opacity).toBe("1"));

    await userEvent.click(plus);
    expect(handleNewThread).toHaveBeenCalledTimes(1);
    expect(handleNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", environmentId: "env-1" }),
    );
  });

  it("indents a grid heading one step in from the project heading", async () => {
    resetTestState();
    await using screen = await render(<CollapsibleSections sections={[projectWithGrid()]} />);
    const project = heading(screen, "Houston");
    const gridHeading = heading(screen, "Grid 1");
    const projectChevron = project
      .querySelector("[data-project-chevron-box]")!
      .getBoundingClientRect();
    const gridChevron = gridHeading
      .querySelector("[data-grid-chevron-box]")!
      .getBoundingClientRect();
    expect(gridChevron.left - projectChevron.left).toBe(8);
    const gridName = gridHeading.querySelector<HTMLElement>("span.truncate")!;
    expect(getComputedStyle(gridName).fontSize).toBe("12px");
    expect(getComputedStyle(gridName).fontWeight).toBe("600");
    expect(gridHeading.querySelector("[data-heading-count]")?.textContent).toBe("2");
    expect(gridHeading.querySelector("[data-attention-pip='failed']")?.textContent).toBe("1");
  });
});

describe("sticky project heading", () => {
  const rail = (children: ReactNode) => (
    <div
      data-slot="scroll-area-viewport"
      style={{ height: 240, overflowY: "auto", width: 280, background: "var(--sidebar)" }}
    >
      {children}
    </div>
  );

  it("pins on the rail's background with a bottom border only while it is stuck", async () => {
    resetTestState();
    const sections = [
      section({ ungroupedThreads: manyThreads(10) }),
      section({ projectKey: "env-1:project-2", title: "notes", projectId: "project-2" }),
    ];
    await using screen = await render(rail(<CollapsibleSections sections={sections} />));
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    const projectHeading = viewport.querySelector<HTMLElement>("[data-project-heading]")!;

    expect(projectHeading.hasAttribute("data-stuck")).toBe(false);
    expect(getComputedStyle(projectHeading).borderBottomColor).toBe("rgba(0, 0, 0, 0)");

    viewport.scrollTop = 200;
    await vi.waitFor(() => expect(projectHeading.hasAttribute("data-stuck")).toBe(true));
    expect(getComputedStyle(projectHeading).position).toBe("sticky");
    expect(getComputedStyle(projectHeading).borderBottomWidth).toBe("1px");
    expect(getComputedStyle(projectHeading).borderBottomColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(projectHeading).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(projectHeading).opacity).toBe("1");
    expect(Math.round(projectHeading.getBoundingClientRect().top)).toBeLessThanOrEqual(
      Math.round(viewport.getBoundingClientRect().top),
    );

    viewport.scrollTop = 0;
    await vi.waitFor(() => expect(projectHeading.hasAttribute("data-stuck")).toBe(false));
    expect(getComputedStyle(projectHeading).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
  });
});
