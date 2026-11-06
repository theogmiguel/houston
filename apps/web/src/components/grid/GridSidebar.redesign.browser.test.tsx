import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useGridStore, type GridRecord } from "../../grid/gridStore";
import { clearThreadSelection } from "../../grid/sidebar";
import { beginThreadDragAt, endThreadDrag } from "../../grid/threadDrag";
import { act, render, type Screen } from "../../../test/render";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { SidebarNewGridMenu, SidebarOptionsMenu } from "../ui/sidebar-grids";
import { TooltipProvider } from "../ui/tooltip";
import { GridGroup } from "./GridSidebar";

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
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    onOpenThread?: (gridId: string, threadId: string) => void;
    onDropOnGrid?: (source: unknown, gridId: string) => void;
  } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <GridGroup
        grid={value}
        workspaceTitle={overrides.workspaceTitle ?? "Houston"}
        threads={threads}
        query=""
        open={overrides.open ?? false}
        collapsed={overrides.collapsed ?? false}
        onToggleCollapsed={overrides.onToggleCollapsed ?? (() => {})}
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
        onDropOnGrid={overrides.onDropOnGrid ?? (() => {})}
        onDropOnThread={() => {}}
        onCreateThread={() => {}}
        onRenameThread={() => {}}
        onSetAutoClose={() => {}}
        onShowGrid={() => {}}
        onCreateGrid={() => {}}
      />
    </TooltipProvider>
  );
}

function headingFor(screen: Screen, gridId: string): HTMLButtonElement {
  const heading = screen.container.querySelector(
    `[data-grid-key="${gridId}"] button[aria-expanded]`,
  );
  if (!(heading instanceof HTMLButtonElement)) {
    throw new Error(`The grid ${gridId} has no heading button.`);
  }
  return heading;
}

function headingGeometry(heading: HTMLButtonElement) {
  const chevron = heading.querySelector("svg");
  const chevronBox = heading.querySelector("[data-grid-chevron-box]");
  const name = heading.children[1];
  if (chevron === null || chevronBox === null || name === undefined) {
    throw new Error("The grid heading is missing its chevron box or grid name.");
  }
  const chevronRect = chevronBox.getBoundingClientRect();
  return {
    chevron,
    chevronLeft: chevronRect.left,
    chevronWidth: chevronRect.width,
    textLeft: name.getBoundingClientRect().left,
  };
}

function expectSameX(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

function CollapsibleGroup({
  value,
  threads,
  workspaceTitle,
}: {
  value: GridRecord;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  workspaceTitle?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return group(value, threads, {
    collapsed,
    ...(workspaceTitle === undefined ? {} : { workspaceTitle }),
    onToggleCollapsed: () => setCollapsed((current) => !current),
  });
}

describe("grid sidebar", () => {
  it("lists a grid without repeating its project name", async () => {
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

    expect(screen.getByRole("button", { name: /^v2 port$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^Grid 2 empty$/ }).element()).toBeVisible();
    expect(screen.container.textContent).not.toContain("notes");
    expect(screen.container.textContent).not.toContain("Workspaces");
  });

  it("renders a one-thread grid with its heading and an indented thread row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      group(grid({ id: "grid-c", name: "Landing copy" }), [thread({ id: "thread-c" })], {
        workspaceTitle: "houston-site",
        onOpenThread,
      }),
    );

    expect(screen.getByRole("button", { name: /^Landing copy$/ }).element()).toBeVisible();
    expect(screen.container.textContent).not.toContain("houston-site");
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    expect(row.className).toContain("pl-7.5");

    await userEvent.click(screen.getByText("Split drawer state from the thread store").element());
    expect(onOpenThread).toHaveBeenCalledWith("grid-c", "thread-c");
  });

  it("renames a grid from its actions menu and keeps the input until Enter", async () => {
    const value = grid({ id: "grid-r", name: "Grid 1" });
    useGridStore.setState({ grids: [value] });
    await using screen = await render(group(value, [thread({ id: "thread-r" })]));

    await userEvent.click(page.getByRole("button", { name: "Grid actions for Grid 1" }).element());
    await userEvent.click(page.getByRole("menuitem", { name: /Rename grid/ }).element());

    const input = screen.getByRole("textbox");
    await expect.element(input).toBeVisible();
    await expect.element(input).toHaveFocus();

    await userEvent.fill(input.element(), "Review");
    await userEvent.keyboard("{Enter}");
    expect(useGridStore.getState().grids[0]?.name).toBe("Review");
  });

  it("opens the grid menu on right-click and runs its actions", async () => {
    const value = grid({ id: "grid-m", name: "Grid 1" });
    useGridStore.setState({ grids: [value] });
    await using screen = await render(group(value, [thread({ id: "thread-m" })]));

    await userEvent.click(headingFor(screen, "grid-m"), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Pin grid" }).element());
    await expect.poll(() => useGridStore.getState().grids[0]?.pinnedAt).not.toBeNull();

    await userEvent.click(headingFor(screen, "grid-m"), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Rename grid" }).element());
    const input = screen.getByRole("textbox");
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input.element(), "Renamed");
    await userEvent.keyboard("{Enter}");
    expect(useGridStore.getState().grids[0]?.name).toBe("Renamed");
  });

  it("keeps a long thread title clear of the row's hover actions", async () => {
    const value = grid({ id: "grid-l", name: "Grid 1" });
    const title = "App de desenvolvimento para testes com um nome bem comprido";
    await using screen = await render(
      <div style={{ width: 300 }}>{group(value, [thread({ id: "thread-l", title })])}</div>,
    );

    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    await userEvent.hover(row);
    const titleText = row.querySelector("[data-card-open] > span") as HTMLElement;
    const close = screen.getByRole("button", { name: "Close thread" }).element();
    const actions = close.parentElement as HTMLElement;
    await expect
      .poll(() => titleText.getBoundingClientRect().right)
      .toBeLessThanOrEqual(actions.getBoundingClientRect().left);
  });

  it("hides the heading actions again once a clicked heading loses the pointer, and shows them on keyboard focus", async () => {
    const value = grid({ id: "grid-h", name: "Grid 1" });
    await using screen = await render(group(value, [thread({ id: "thread-h" })]));
    const heading = headingFor(screen, "grid-h");
    const add = screen.getByRole("button", { name: "New thread in Grid 1" }).element();
    const more = screen.getByRole("button", { name: "Grid actions for Grid 1" }).element();
    const opacity = (element: Element) => Number(getComputedStyle(element).opacity);

    await userEvent.click(heading);
    await userEvent.unhover(heading);
    await expect.poll(() => opacity(add)).toBe(0);
    expect(opacity(more)).toBe(0);

    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(heading);
    await expect.poll(() => opacity(add)).toBe(1);
    expect(opacity(more)).toBe(1);
  });

  it("renames a grid with F2 on its heading", async () => {
    const value = grid({ id: "grid-f", name: "Grid 1" });
    useGridStore.setState({ grids: [value] });
    await using screen = await render(group(value, []));

    headingFor(screen, "grid-f").focus();
    await userEvent.keyboard("{F2}");
    const input = screen.getByRole("textbox");
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input.element(), "Docs");
    await userEvent.keyboard("{Enter}");
    expect(useGridStore.getState().grids[0]?.name).toBe("Docs");
  });

  it("keeps a one-thread grid's actions on the heading", async () => {
    await using _screen = await render(
      group(grid({ id: "grid-c", name: "Landing copy" }), [thread({ id: "thread-c" })]),
    );

    await userEvent.click(
      page.getByRole("button", { name: "Grid actions for Landing copy" }).element(),
    );
    await expect.element(page.getByRole("menuitem", { name: "New thread" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /Rename grid/ })).toBeVisible();
  });

  it("tints only the open grid's heading", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      <>
        {group(grid({ id: "grid-a", name: "v2 port" }), threads, { open: true })}
        {group(grid({ id: "grid-b", name: "Review" }), threads, { open: false })}
      </>,
    );

    const open = screen.getByRole("button", { name: /^v2 port$/ }).element();
    const closed = screen.getByRole("button", { name: /^Review$/ }).element();
    expect(open.className).toContain("bg-sidebar-row-selected");
    expect(closed.className).not.toContain("bg-sidebar-row-selected");
  });

  it("leaves the open grid's heading untinted while its focused thread row shows the selection", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      group(grid({ id: "grid-a", name: "v2 port", focusedThreadId: "thread-a" }), threads, {
        open: true,
      }),
    );

    const heading = screen.getByRole("button", { name: /^v2 port$/ }).element();
    expect(heading.className).not.toContain("bg-sidebar-row-selected");
  });

  it("tints the open grid's heading when collapsing hides its focused thread", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      group(grid({ id: "grid-a", name: "v2 port", focusedThreadId: "thread-a" }), threads, {
        open: true,
        collapsed: true,
      }),
    );

    const heading = screen.getByRole("button", { name: /^v2 port 2$/ }).element();
    expect(heading.className).toContain("bg-sidebar-row-selected");
  });

  it("keeps the chevron and text still across collapse and thread counts", async () => {
    const counts = [0, 1, 2, 6] as const;
    const makeThreads = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        thread({ id: `thread-${count}-${index}`, title: `Thread ${index}` }),
      );
    await using screen = await render(
      <TooltipProvider delay={0}>
        {counts.map((count) => (
          <CollapsibleGroup
            key={count}
            value={grid({ id: `grid-${count}`, name: "v2 port" })}
            threads={makeThreads(count)}
          />
        ))}
      </TooltipProvider>,
    );

    const reference = headingGeometry(headingFor(screen, "grid-0"));
    expect(reference.chevron.getAttribute("class")).toContain("rotate-90");

    for (const count of counts) {
      const heading = headingFor(screen, `grid-${count}`);
      const expanded = headingGeometry(heading);
      expectSameX(expanded.chevronLeft, reference.chevronLeft);
      expectSameX(expanded.textLeft, reference.textLeft);
      expectSameX(expanded.chevronWidth, reference.chevronWidth);

      await userEvent.click(heading);
      expect(heading.getAttribute("aria-expanded")).toBe("false");
      const collapsed = headingGeometry(heading);
      expect(collapsed.chevron).toBe(expanded.chevron);
      expect(collapsed.chevron.getAttribute("class")).not.toContain("rotate-90");
      expectSameX(collapsed.chevronLeft, reference.chevronLeft);
      expectSameX(collapsed.textLeft, reference.textLeft);
      expectSameX(collapsed.chevronWidth, expanded.chevronWidth);

      const root = screen.container.querySelector(`[data-grid-key="grid-${count}"]`);
      expect(root?.querySelectorAll("[data-thread-key]")).toHaveLength(0);

      await userEvent.click(heading);
      expect(heading.getAttribute("aria-expanded")).toBe("true");
      expect(root?.querySelectorAll("[data-thread-key]")).toHaveLength(count);
      expectSameX(headingGeometry(heading).textLeft, reference.textLeft);
    }
  });

  it("toggles collapse from Enter and Space on the focused heading", async () => {
    await using screen = await render(
      <CollapsibleGroup value={grid({ id: "grid-toggle", name: "Toggle" })} threads={[thread()]} />,
    );
    const heading = headingFor(screen, "grid-toggle");

    heading.focus();
    expect(document.activeElement).toBe(heading);

    await userEvent.keyboard("{Enter}");
    expect(heading.getAttribute("aria-expanded")).toBe("false");

    await userEvent.keyboard(" ");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("truncates long names without moving the chevron or the overflow button", async () => {
    const container = document.createElement("div");
    container.style.width = "220px";
    await using screen = await render(
      <TooltipProvider delay={0}>
        {group(grid({ id: "grid-short", name: "Short" }), [], { workspaceTitle: "ws" })}
        {group(grid({ id: "grid-long", name: "A very long grid name that never fits" }), [], {
          workspaceTitle: "A very long workspace name that never fits",
        })}
      </TooltipProvider>,
      { container },
    );

    const short = headingFor(screen, "grid-short");
    const long = headingFor(screen, "grid-long");
    const shortGeometry = headingGeometry(short);
    const longGeometry = headingGeometry(long);
    expectSameX(longGeometry.chevronLeft, shortGeometry.chevronLeft);
    expectSameX(longGeometry.textLeft, shortGeometry.textLeft);

    const shortActions = screen.getByRole("button", { name: "Grid actions for Short" }).element();
    const longActions = screen
      .getByRole("button", { name: "Grid actions for A very long grid name that never fits" })
      .element();
    expectSameX(
      longActions.getBoundingClientRect().left,
      shortActions.getBoundingClientRect().left,
    );
    expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth + 1);
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
    const selected = page.getByRole("menuitem", { name: "notes" }).element();
    expect(selected.getAttribute("data-selected")).toBe("");
    await vi.waitUntil(() => document.activeElement?.getAttribute("role") === "menu");

    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("env-1:project-3");
  });

  it("creates in the preselected workspace with Space before any navigation", async () => {
    const onSelect = vi.fn();
    await using _screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-2"
        onSelect={onSelect}
        onOpenFolder={() => {}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    await vi.waitUntil(() => document.activeElement?.getAttribute("role") === "menu");

    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("env-1:project-2");
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
    await userEvent.click(page.getByRole("menuitem", { name: "houston-site" }).element());
    expect(onSelect).toHaveBeenCalledWith("env-1:project-2");
  });

  it("names the grid from the optional field with Enter", async () => {
    const onSelect = vi.fn();
    await using screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-2"
        onSelect={onSelect}
        onOpenFolder={() => {}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    const field = screen.getByRole("textbox", { name: "Grid name" });
    await userEvent.fill(field.element(), "  Review sprint ");
    await expect.element(field).toHaveValue("  Review sprint ");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("env-1:project-2", "Review sprint");
  });

  it("names the grid in the workspace whose row is clicked, and a blank name keeps the default", async () => {
    const onSelect = vi.fn();
    await using screen = await render(
      <SidebarNewGridMenu
        workspaces={workspaces}
        selectedKey="env-1:project-1"
        onSelect={onSelect}
        onOpenFolder={() => {}}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    await userEvent.fill(screen.getByRole("textbox", { name: "Grid name" }).element(), "Docs");
    await userEvent.click(page.getByRole("menuitem", { name: "notes" }).element());
    expect(onSelect).toHaveBeenLastCalledWith("env-1:project-3", "Docs");

    await userEvent.click(page.getByRole("button", { name: "New grid" }).element());
    await userEvent.fill(screen.getByRole("textbox", { name: "Grid name" }).element(), "   ");
    await userEvent.click(page.getByRole("menuitem", { name: "notes" }).element());
    expect(onSelect).toHaveBeenLastCalledWith("env-1:project-3");
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
    await userEvent.click(page.getByRole("menuitem", { name: /Open folder/ }).element());
    expect(onOpenFolder).toHaveBeenCalledTimes(1);
  });
});

describe("View options", () => {
  const defaults = {
    threadSort: "grid",
    gridSort: "created_at",
    showBranch: true,
    showPullRequest: true,
    showSubagents: true,
  } as const;

  it("offers sorts, row fields and a reset, and reports each pick", async () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    await using screen = await render(
      <SidebarOptionsMenu options={defaults} onChange={onChange} onReset={onReset} />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "View options" }));
    await expect.element(page.getByText("Sort threads")).toBeVisible();
    await expect.element(page.getByText("Sort grids")).toBeVisible();
    await expect.element(page.getByText("Rows show")).toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Grid order" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Branch" }))
      .toHaveAttribute("aria-checked", "true");
    expect(page.getByRole("menuitemcheckbox", { name: "Working shelf" }).elements()).toHaveLength(
      0,
    );

    await userEvent.click(page.getByRole("menuitemradio", { name: "Manual" }));
    expect(onChange).toHaveBeenCalledWith({ gridSort: "manual" });
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Subagents" }));
    expect(onChange).toHaveBeenCalledWith({ showSubagents: false });
    await userEvent.click(page.getByRole("menuitem", { name: "Reset to defaults" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("draws New grid as a folder with a plus", async () => {
    await using screen = await render(
      <SidebarNewGridMenu
        workspaces={[{ key: "env-1:project-1", label: "Houston" }]}
        selectedKey="env-1:project-1"
        onSelect={() => {}}
        onOpenFolder={() => {}}
      />,
      { router: false },
    );
    const trigger = screen.getByRole("button", { name: "New grid" }).element();
    expect(trigger.querySelector("svg.lucide-folder-plus")).not.toBeNull();
  });

  it("hides the branch line when Rows show leaves Branch off", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    try {
      {
        await using shown = await render(group(grid(), [thread()]), { router: false });
        expect(shown.container.textContent).toContain("houston/split-drawer-state");
      }
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarRowShowBranch: false });
      await using hidden = await render(group(grid(), [thread()]), { router: false });
      expect(hidden.container.textContent).not.toContain("houston/split-drawer-state");
    } finally {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    }
  });

  it("moves a dragged thread onto the grid whose heading is under the pointer", async () => {
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onDropOnGrid = vi.fn();
    await using screen = await render(group(grid(), [], { onDropOnGrid }), { router: false });
    const heading = headingFor(screen, "grid-a");
    const rect = heading.getBoundingClientRect();
    const source = {
      gridId: "grid-other",
      threadId: "thread-a",
      environmentId: "env-1",
      projectId: "project-1",
    };

    await act(() =>
      beginThreadDragAt(
        source,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    expect(onDropOnGrid).toHaveBeenCalledWith(source, "grid-a");
  });
});
