import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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

function section(
  id: string,
  threads: EnvironmentThreadShell[],
  overrides: Partial<SidebarWorkspaceSection> = {},
): SidebarWorkspaceSection {
  return {
    workspaceId: id,
    name: id,
    pinned: false,
    hidden: false,
    empty: threads.length === 0,
    threads,
    needsYouThreads: [],
    ...overrides,
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

const needsYou = (id = "asks") => thread(id, { hasPendingUserInput: true });
const rect = (element: Element) => element.getBoundingClientRect();
const rails = [280, 240] as const;

function tree(
  values: ReadonlyArray<{
    value: SidebarWorkspaceSection;
    overrides?: Partial<ComponentProps<typeof SidebarWorkspaceGroup>>;
  }>,
  width = 280,
) {
  return (
    <TooltipProvider delay={0}>
      <div style={{ width }} className="flex flex-col gap-px">
        {values.map(({ value, overrides }) => (
          <SidebarWorkspaceGroup key={value.workspaceId} {...groupProps(value, overrides)} />
        ))}
      </div>
    </TooltipProvider>
  );
}

const workspaceRow = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-workspace-key="${id}"] [data-workspace-heading-row]`)!;
const cardsOf = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-workspace-key="${id}"] [data-workspace-guide]`);

describe("sidebar tree: workspace row", () => {
  it("is a 24px regular muted row with a chevron that stays put, and the workspace on screen takes primary ink", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([
        { value: section("w1", [thread("a")]), overrides: { open: true } },
        { value: section("w2", [thread("b")]) },
      ]),
    );
    const onScreen = workspaceRow(screen.container, "w1");
    const other = workspaceRow(screen.container, "w2");
    expect(rect(onScreen).height).toBe(24);
    const name = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-workspace-name]")!;
    expect(getComputedStyle(name(other)).fontSize).toBe("12px");
    expect(Number(getComputedStyle(name(other)).fontWeight)).toBe(400);
    expect(getComputedStyle(name(onScreen)).color).not.toBe(getComputedStyle(name(other)).color);
    const chevron = other.querySelector<HTMLElement>("[data-workspace-chevron-box]")!;
    expect(rect(chevron).width).toBe(14);
  });

  it("keeps primary ink on the workspace on screen while it is collapsed", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([
        { value: section("w1", [thread("a")]), overrides: { open: true, collapsed: true } },
        { value: section("w2", [thread("b")]), overrides: { collapsed: true } },
      ]),
    );
    const name = (id: string) =>
      workspaceRow(screen.container, id).querySelector<HTMLElement>("[data-workspace-name]")!;
    expect(getComputedStyle(name("w1")).color).not.toBe(getComputedStyle(name("w2")).color);
  });

  it("shows the count and dot only while collapsed, and keeps the empty label on the right", async () => {
    await page.viewport(1440, 900);
    const busy = section("w1", [thread("a"), needsYou()]);
    const empty = section("w2", []);
    await using screen = await render(
      tree([{ value: busy, overrides: { collapsed: true } }, { value: empty }]),
    );
    const collapsed = workspaceRow(screen.container, "w1");
    const count = collapsed.querySelector<HTMLElement>("[data-heading-count]")!;
    expect(count.textContent).toBe("2");
    expect(collapsed.querySelector("[data-needs-you-dot]")).not.toBeNull();
    expect(rect(count).right).toBeCloseTo(rect(collapsed).right - 8, 0);

    const emptyRow = workspaceRow(screen.container, "w2");
    const label = [...emptyRow.querySelectorAll<HTMLElement>("span")].find(
      (node) => node.textContent === "empty",
    )!;
    expect(rect(label).right).toBeCloseTo(rect(emptyRow).right - 8, 0);

    await screen.rerender(tree([{ value: busy }, { value: empty }]));
    expect(workspaceRow(screen.container, "w1").querySelector("[data-heading-count]")).toBeNull();
    expect(workspaceRow(screen.container, "w1").querySelector("[data-needs-you-dot]")).toBeNull();
  });
});

describe("sidebar tree: guides and alignment", () => {
  it("draws the workspace guide under the chevron", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([{ value: section("w1", [thread("a")]), overrides: { open: true } }]),
    );
    const chevron = workspaceRow(screen.container, "w1").querySelector<HTMLElement>(
      "[data-workspace-chevron-box]",
    )!;
    const cards = cardsOf(screen.container, "w1")!;
    expect(getComputedStyle(cards).borderLeftWidth).toBe("1px");
    const chevronCentre = rect(chevron).left + rect(chevron).width / 2;
    expect(Math.abs(rect(cards).left + 0.5 - chevronCentre)).toBeLessThanOrEqual(1);
  });

  it("draws the guide in the border tone even when a theme's sidebar border is as dark as the rail", async () => {
    await page.viewport(1440, 900);
    const root = document.documentElement;
    root.style.setProperty("--sidebar-border", "rgb(15, 15, 17)");
    try {
      await using screen = await render(
        tree([
          { value: section("w1", [thread("a")]), overrides: { open: true } },
          { value: section("w2", [thread("b")]) },
        ]),
      );
      const probe = document.createElement("div");
      probe.className = "border border-border";
      screen.container.append(probe);
      const border = getComputedStyle(probe).borderTopColor;
      expect(getComputedStyle(cardsOf(screen.container, "w2")!).borderLeftColor).toBe(border);
    } finally {
      root.style.removeProperty("--sidebar-border");
    }
  });

  it("draws the guide in a light ink inside the dark sidebar, so it shows against the rail", async () => {
    await page.viewport(1440, 900);
    const root = document.documentElement;
    root.classList.add("dark");
    try {
      await using screen = await render(
        <div data-app-sidebar="">
          {tree([
            { value: section("w1", [thread("a")]), overrides: { open: true } },
            { value: section("w2", [thread("b")]) },
          ])}
        </div>,
      );
      // Normalised sRGB channels of a computed colour, whatever notation the engine prints.
      const channels = (color: string) => {
        const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
        const scale = color.startsWith("color(") ? 1 : 255;
        return [r! / scale, g! / scale, b! / scale];
      };
      const [r, g, b] = channels(
        getComputedStyle(cardsOf(screen.container, "w2")!).borderLeftColor,
      );
      expect((r! + g! + b!) / 3, "guide ink").toBeGreaterThan(0.5);
    } finally {
      root.classList.remove("dark");
    }
  });

  it("tones the on-screen workspace's guide stronger than the others, with no colour transition", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([
        { value: section("w1", [thread("a")]), overrides: { open: true } },
        { value: section("w2", [thread("b")]) },
      ]),
    );
    const on = getComputedStyle(cardsOf(screen.container, "w1")!);
    const off = getComputedStyle(cardsOf(screen.container, "w2")!);
    expect(on.borderLeftColor).not.toBe(off.borderLeftColor);
    expect(on.transitionProperty).not.toContain("color");
    expect(off.transitionProperty).not.toContain("color");
  });

  it("puts workspace names and thread titles on one left edge, with the card spanning the row's width", async () => {
    await page.viewport(1440, 900);
    for (const width of rails) {
      await using screen = await render(
        tree([{ value: section("w1", [thread("a")]), overrides: { open: true } }], width),
      );
      const card = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
      const row = workspaceRow(screen.container, "w1");
      const name = row.querySelector<HTMLElement>("[data-workspace-name]")!;
      const title = card.querySelector<HTMLElement>("[data-card-open]")!;
      expect(rect(name).left).toBeCloseTo(rect(title).left, 0);
      expect(rect(card).right).toBeCloseTo(rect(row).right, 0);
    }
  });

  it("leaves 7px between a workspace's last card and the next workspace row, and 3px between collapsed ones (2px margin plus the rail's 1px gap)", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([
        { value: section("w1", [thread("a")]), overrides: { open: true } },
        { value: section("w2", [thread("b")]), overrides: { collapsed: true } },
        { value: section("w3", [thread("c")]), overrides: { collapsed: true } },
      ]),
    );
    const card = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    const afterCards = rect(workspaceRow(screen.container, "w2")).top - rect(card).bottom;
    const betweenBare =
      rect(workspaceRow(screen.container, "w3")).top -
      rect(workspaceRow(screen.container, "w2")).bottom;
    expect(afterCards).toBeCloseTo(7, 0);
    expect(betweenBare).toBeCloseTo(3, 0);
  });
});

describe("sidebar tree: hover and focus", () => {
  it("keeps the workspace actions on the row's right edge, shown on hover by opacity", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([{ value: section("w1", [thread("a")]), overrides: { open: true } }]),
    );
    const row = workspaceRow(screen.container, "w1");
    const more = row.querySelector<HTMLElement>('[aria-label^="Workspace actions"]')!;
    expect(getComputedStyle(more).opacity).toBe("0");
    expect(getComputedStyle(more).display).not.toBe("none");
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(more).opacity).toBe("1");
    expect(rect(more).right).toBeLessThanOrEqual(rect(row).right + 0.5);
  });

  it("hides the collapsed count while the actions are shown, without toggling display", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      tree([{ value: section("w1", [thread("a")]), overrides: { collapsed: true } }]),
    );
    const row = workspaceRow(screen.container, "w1");
    const count = row.querySelector<HTMLElement>("[data-heading-trailing]")!;
    expect(getComputedStyle(count).opacity).toBe("1");
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(count).opacity).toBe("0");
    expect(getComputedStyle(count).display).not.toBe("none");
  });

  it("draws keyboard focus as the inset ring on the row's button", async () => {
    await page.viewport(1440, 900);
    await using _screen = await render(tree([{ value: section("w1", [thread("a")]) }]));
    await userEvent.tab();
    const focused = document.activeElement as HTMLElement;
    expect(focused.matches("[data-sidebar-row]")).toBe(true);
    expect(getComputedStyle(focused).boxShadow).toContain("inset");
  });
});
