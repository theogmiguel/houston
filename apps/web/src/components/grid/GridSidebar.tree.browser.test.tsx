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
  title = "Houston",
): SidebarProjectSectionModel {
  return {
    projectKey: `env-1:${title}`,
    title,
    isScratch: false,
    environmentId: "env-1",
    projectId: "project-1",
    grids,
    hiddenGrids: [],
    ungroupedThreads,
  };
}

const needsYou = (id = "asks") => thread(id, { hasPendingUserInput: true });
const rect = (element: Element) => element.getBoundingClientRect();
const rails = [280, 240] as const;

function tree(
  value: SidebarProjectSectionModel,
  overrides: Partial<ComponentProps<typeof SidebarProjectSection>> = {},
  width = 280,
) {
  return (
    <TooltipProvider delay={0}>
      <div style={{ width }} className="flex flex-col gap-px">
        <SidebarProjectSection {...props(value, { collapsed: false, ...overrides })} />
      </div>
    </TooltipProvider>
  );
}

const projectRow = (root: ParentNode) => root.querySelector<HTMLElement>("[data-project-heading]")!;
const gridRow = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-grid-key="${id}"] [data-grid-heading-row]`)!;
const cardsOf = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-grid-key="${id}"] [data-grid-guide]`);

describe("sidebar tree: project row", () => {
  it("is a 28px bold row, and a project with nothing in it is regular and muted", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: 280 }} className="flex flex-col gap-px">
          <SidebarProjectSection
            {...props(section([{ grid: grid("g1", null), threads: [thread("a")] }], [], "Full"), {
              collapsed: false,
            })}
          />
          <SidebarProjectSection {...props(section([], [], "Empty"), { collapsed: false })} />
        </div>
      </TooltipProvider>,
    );
    const rows = [...screen.container.querySelectorAll<HTMLElement>("[data-project-heading]")];
    expect(rows.map((row) => rect(row).height)).toEqual([28, 28]);
    const label = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-sidebar-row]")!;
    expect(Number(getComputedStyle(label(rows[0]!)).fontWeight)).toBeGreaterThanOrEqual(600);
    expect(Number(getComputedStyle(label(rows[1]!)).fontWeight)).toBe(400);
    expect(getComputedStyle(label(rows[1]!)).color).not.toBe(
      getComputedStyle(label(rows[0]!)).color,
    );
  });

  it("sits 12px below the project above it and 2px below the header when first", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: 280 }} className="flex flex-col">
          <SidebarProjectSection {...props(section([], [], "One"), { collapsed: true })} />
          <SidebarProjectSection {...props(section([], [], "Two"), { collapsed: true })} />
        </div>
      </TooltipProvider>,
    );
    const wrappers = [...screen.container.querySelectorAll<HTMLElement>("[data-project-key]")];
    expect(getComputedStyle(wrappers[0]!).marginTop).toBe("2px");
    expect(getComputedStyle(wrappers[1]!).marginTop).toBe("12px");
  });

  it("shows the thread count with an amber dot only while collapsed, at the right edge", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", null), threads: [thread("a"), needsYou()] }]);
    await using screen = await render(tree(value, { collapsed: true }));
    const row = projectRow(screen.container);
    const count = row.querySelector<HTMLElement>("[data-heading-count]")!;
    expect(count.textContent).toBe("2");
    const dot = row.querySelector<HTMLElement>("[data-needs-you-dot]")!;
    expect(rect(dot).width).toBe(6);
    expect(rect(dot).right).toBeLessThan(rect(count).left);
    expect(rect(count).right).toBeCloseTo(rect(row).right - 8, 0);
    expect(dot.getAttribute("aria-hidden")).toBe("true");

    await screen.rerender(tree(value, { collapsed: false }));
    expect(projectRow(screen.container).querySelector("[data-heading-count]")).toBeNull();
    expect(projectRow(screen.container).querySelector("[data-needs-you-dot]")).toBeNull();
  });

  it("shows no dot when nothing inside needs the user", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree(section([{ grid: grid("g1", null), threads: [thread("a")] }]), { collapsed: true }),
    );
    expect(screen.container.querySelector("[data-needs-you-dot]")).toBeNull();
    expect(screen.container.querySelector("[data-heading-count]")?.textContent).toBe("1");
  });
});

describe("sidebar tree: grid row", () => {
  it("is a 24px regular muted row with a chevron that stays put, and the grid on screen takes primary ink", async () => {
    await page.viewport(1440, 900);
    const value = section([
      { grid: grid("g1", "a"), threads: [thread("a")] },
      { grid: grid("g2", "b"), threads: [thread("b")] },
    ]);
    await using screen = await render(tree(value, { openGridId: "g1" }));
    const onScreen = gridRow(screen.container, "g1");
    const other = gridRow(screen.container, "g2");
    expect(rect(onScreen).height).toBe(24);
    const name = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-grid-name]")!;
    expect(getComputedStyle(name(other)).fontSize).toBe("12px");
    expect(Number(getComputedStyle(name(other)).fontWeight)).toBe(400);
    expect(getComputedStyle(name(onScreen)).color).not.toBe(getComputedStyle(name(other)).color);
    const chevron = other.querySelector<HTMLElement>("[data-grid-chevron-box]")!;
    expect(rect(chevron).width).toBe(14);
  });

  it("keeps primary ink on the grid on screen while it is collapsed", async () => {
    await page.viewport(1440, 900);
    const value = section([
      { grid: grid("g1", "a"), threads: [thread("a")] },
      { grid: grid("g2", "b"), threads: [thread("b")] },
    ]);
    await using screen = await render(
      tree(value, { openGridId: "g1", collapsedGridIds: new Set(["g1", "g2"]) }),
    );
    const name = (id: string) =>
      gridRow(screen.container, id).querySelector<HTMLElement>("[data-grid-name]")!;
    expect(getComputedStyle(name("g1")).color).not.toBe(getComputedStyle(name("g2")).color);
  });

  it("shows the count and dot only while collapsed, and keeps the empty label on the right", async () => {
    await page.viewport(1440, 900);
    const value = section([
      { grid: grid("g1", null), threads: [thread("a"), needsYou()] },
      { grid: grid("g2", null), threads: [] },
    ]);
    await using screen = await render(tree(value, { collapsedGridIds: new Set(["g1"]) }));
    const collapsed = gridRow(screen.container, "g1");
    const count = collapsed.querySelector<HTMLElement>("[data-heading-count]")!;
    expect(count.textContent).toBe("2");
    expect(collapsed.querySelector("[data-needs-you-dot]")).not.toBeNull();
    expect(rect(count).right).toBeCloseTo(rect(collapsed).right - 8, 0);

    const empty = gridRow(screen.container, "g2");
    const label = [...empty.querySelectorAll<HTMLElement>("span")].find(
      (node) => node.textContent === "empty",
    )!;
    expect(rect(label).right).toBeCloseTo(rect(empty).right - 8, 0);

    await screen.rerender(tree(value, { collapsedGridIds: new Set() }));
    expect(gridRow(screen.container, "g1").querySelector("[data-heading-count]")).toBeNull();
    expect(gridRow(screen.container, "g1").querySelector("[data-needs-you-dot]")).toBeNull();
  });
});

describe("sidebar tree: guides and alignment", () => {
  it("draws the project guide under the folder glyph and the grid guide under the chevron", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", "a"), threads: [thread("a")] }]);
    await using screen = await render(tree(value, { openGridId: "g1" }));
    const project = projectRow(screen.container);
    const folder = project.querySelector<HTMLElement>("[data-project-icon-box]")!;
    const kids = screen.container.querySelector<HTMLElement>("[data-project-guide]")!;
    expect(getComputedStyle(kids).borderLeftWidth).toBe("1px");
    const folderCentre = rect(folder).left + rect(folder).width / 2;
    expect(Math.abs(rect(kids).left + 0.5 - folderCentre)).toBeLessThanOrEqual(1);

    const chevron = gridRow(screen.container, "g1").querySelector<HTMLElement>(
      "[data-grid-chevron-box]",
    )!;
    const cards = cardsOf(screen.container, "g1")!;
    expect(getComputedStyle(cards).borderLeftWidth).toBe("1px");
    const chevronCentre = rect(chevron).left + rect(chevron).width / 2;
    expect(Math.abs(rect(cards).left + 0.5 - chevronCentre)).toBeLessThanOrEqual(1);
  });

  it("draws the guides in the border tone even when a theme's sidebar border is as dark as the rail", async () => {
    await page.viewport(1440, 900);
    const root = document.documentElement;
    root.style.setProperty("--sidebar-border", "rgb(15, 15, 17)");
    try {
      const value = section([
        { grid: grid("g1", "a"), threads: [thread("a")] },
        { grid: grid("g2", "b"), threads: [thread("b")] },
      ]);
      await using screen = await render(tree(value, { openGridId: "g1" }));
      const probe = document.createElement("div");
      probe.className = "border border-border";
      screen.container.append(probe);
      const border = getComputedStyle(probe).borderTopColor;
      const projectGuide = screen.container.querySelector<HTMLElement>("[data-project-guide]")!;
      expect(getComputedStyle(projectGuide).borderLeftColor, "project guide").toBe(border);
      expect(getComputedStyle(cardsOf(screen.container, "g2")!).borderLeftColor, "grid guide").toBe(
        border,
      );
    } finally {
      root.style.removeProperty("--sidebar-border");
    }
  });

  it("tones the on-screen grid's guide stronger than the others, with no colour transition", async () => {
    await page.viewport(1440, 900);
    const value = section([
      { grid: grid("g1", "a"), threads: [thread("a")] },
      { grid: grid("g2", "b"), threads: [thread("b")] },
    ]);
    await using screen = await render(tree(value, { openGridId: "g1" }));
    const on = getComputedStyle(cardsOf(screen.container, "g1")!);
    const off = getComputedStyle(cardsOf(screen.container, "g2")!);
    expect(on.borderLeftColor).not.toBe(off.borderLeftColor);
    expect(on.transitionProperty).not.toContain("color");
    expect(off.transitionProperty).not.toContain("color");
  });

  it("starts a card 28px right of its project row, with grid names and thread titles on one left edge", async () => {
    await page.viewport(1440, 900);
    for (const width of rails) {
      const value = section([{ grid: grid("g1", "a"), threads: [thread("a")] }]);
      await using screen = await render(tree(value, { openGridId: "g1" }, width));
      const card = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
      const row = projectRow(screen.container);
      expect(rect(card).left - rect(row).left).toBeCloseTo(28, 0);
      const name = gridRow(screen.container, "g1").querySelector<HTMLElement>("[data-grid-name]")!;
      const title = card.querySelector<HTMLElement>("[data-card-open]")!;
      expect(rect(name).left).toBeCloseTo(rect(title).left, 0);
      expect(rect(card).right).toBeCloseTo(rect(row).right, 0);
    }
  });

  it("puts ungrouped threads on the project guide after its grids, 6px below the last grid", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", null), threads: [] }], [thread("loose")]);
    await using screen = await render(tree(value));
    const loose = screen.container.querySelector<HTMLElement>("[data-thread-key$=':loose']")!;
    const grids = gridRow(screen.container, "g1");
    const kids = screen.container.querySelector<HTMLElement>("[data-project-guide]")!;
    expect(rect(loose).top - rect(grids).bottom).toBeCloseTo(6, 0);
    expect(rect(loose).left).toBeGreaterThan(rect(kids).left);
    expect(rect(loose).bottom).toBeLessThanOrEqual(rect(kids).bottom + 0.5);
  });

  it("leaves 6px between a grid's last card and the next grid row, and 2px between bare grid rows", async () => {
    await page.viewport(1440, 900);
    const value = section([
      { grid: grid("g1", "a"), threads: [thread("a")] },
      { grid: grid("g2", null), threads: [] },
      { grid: grid("g3", null), threads: [] },
    ]);
    await using screen = await render(tree(value, { openGridId: "g1" }));
    const card = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    expect(rect(gridRow(screen.container, "g2")).top - rect(card).bottom).toBeCloseTo(6, 0);
    expect(
      rect(gridRow(screen.container, "g3")).top - rect(gridRow(screen.container, "g2")).bottom,
    ).toBeCloseTo(2, 0);
  });
});

describe("sidebar tree: hover and focus", () => {
  it("reveals row actions by opacity at the right edge and hides the count meanwhile, without toggling display", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", "a"), threads: [thread("a")] }]);
    await using screen = await render(tree(value, { collapsed: true }));
    const row = projectRow(screen.container);
    const plus = row.querySelector<HTMLElement>('[aria-label="New grid in Houston"]');
    const more = plus;
    const count = row.querySelector<HTMLElement>("[data-heading-trailing]")!;
    const actions = [plus, more].filter((node): node is HTMLElement => node !== null);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(getComputedStyle(action).display).not.toBe("none");
      expect(getComputedStyle(action).opacity).toBe("0");
    }
    expect(getComputedStyle(count).opacity).toBe("1");
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(actions[0]!).opacity).toBe("1");
    await expect.poll(() => getComputedStyle(count).opacity).toBe("0");
    expect(getComputedStyle(count).display).not.toBe("none");
    const last = actions.at(-1)!;
    expect(rect(last).right).toBeLessThanOrEqual(rect(row).right - 3 + 0.5);
  });

  it("keeps the grid actions on the row's right edge, shown on hover by opacity", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", "a"), threads: [thread("a")] }]);
    await using screen = await render(tree(value, { openGridId: "g1" }));
    const row = gridRow(screen.container, "g1");
    const more = row.querySelector<HTMLElement>('[aria-label^="Grid actions"]')!;
    expect(getComputedStyle(more).opacity).toBe("0");
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(more).opacity).toBe("1");
    expect(rect(more).right).toBeLessThanOrEqual(rect(row).right + 0.5);
  });

  it("draws keyboard focus as the inset ring on the row's button", async () => {
    await page.viewport(1440, 900);
    const value = section([{ grid: grid("g1", "a"), threads: [thread("a")] }]);
    await using _screen = await render(tree(value));
    await userEvent.tab();
    const focused = document.activeElement as HTMLElement;
    expect(focused.matches("[data-sidebar-row]")).toBe(true);
    expect(getComputedStyle(focused).boxShadow).toContain("inset");
  });
});
