import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import { findLayoutTab, type LayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutPaneTabBar, type LayoutTabLabel } from "./PaneTabBar";

const label = (tab: LayoutTab): LayoutTabLabel => ({
  title: tab.id,
  tooltip: `Thread ${tab.id}`,
});

/** Puts a layout in the store for one test and empties the store when the test ends. */
function openLayout(shape: string[][][][]): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: () => useLayoutStore.getState().reset() };
}

function BarOf({
  paneId = "w0c0p0",
  placement = "pane",
  width = 480,
  ...rest
}: Partial<React.ComponentProps<typeof LayoutPaneTabBar>> & { width?: number }) {
  const layout = useLayoutStore((state) => state.layout);
  const pane = layout.workspaces[0]!.columns[0]!.panes[0]!;
  return (
    <div style={{ width, position: "relative" }}>
      <LayoutPaneTabBar
        paneId={paneId}
        tabs={pane.tabs}
        activeTabId={pane.activeTabId}
        placement={placement}
        tabLabel={label}
        {...rest}
      />
    </div>
  );
}

describe("tabs", () => {
  it("marks the pane's active tab and none of the others", async () => {
    using _layout = openLayout([[[["a", "b", "c"]]]]);
    await using screen = await render(<BarOf />, { router: false });
    const tabs = screen.container.querySelectorAll<HTMLElement>("[data-layout-pane-tab]");
    expect([...tabs].map((tab) => tab.hasAttribute("data-active"))).toEqual([true, false, false]);
    expect(getComputedStyle(tabs[0]!).fontWeight).toBe("500");
    expect(getComputedStyle(tabs[1]!).fontWeight).not.toBe("500");
  });

  it("shows an inactive tab's pane on click", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf />, { router: false });
    await userEvent.click(screen.getByText("b"));
    const location = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "b");
    expect(location?.pane.activeTabId).toBe("b");
  });

  it("keeps a ghost tab provisional until it is double-clicked", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    const layout = useLayoutStore.getState().layout;
    layout.workspaces[0]!.columns[0]!.panes[0]!.tabs[1]!.ghostOf = null;
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<BarOf />, { router: false });
    const ghost = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab='b']")!;
    expect(ghost.hasAttribute("data-ghost")).toBe(true);
    expect(getComputedStyle(ghost).fontStyle).toBe("italic");
    await userEvent.dblClick(ghost);
    expect(
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "b")?.tab.ghostOf,
    ).toBeUndefined();
  });

  it("draws a mark for running, attention and unsaved work", async () => {
    using _layout = openLayout([[[["a", "b", "c"]]]]);
    const marks = new Map<string, LayoutTabLabel["mark"]>([
      ["a", "running"],
      ["b", "attention"],
      ["c", "dirty"],
    ]);
    await using screen = await render(
      <BarOf tabLabel={(tab) => ({ ...label(tab), mark: marks.get(tab.id) })} />,
      { router: false },
    );
    expect(
      [...screen.container.querySelectorAll("[data-layout-tab-mark]")].map((mark) =>
        mark.getAttribute("data-layout-tab-mark"),
      ),
    ).toEqual(["running", "attention", "dirty"]);
  });
});

describe("closing", () => {
  it("closes a tab from its close button", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Close b" }));
    expect(findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "b")).toBeNull();
  });

  it("closes a tab on a middle click", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf />, { router: false });
    await userEvent.click(screen.getByText("b"), { button: "middle" });
    expect(findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "b")).toBeNull();
  });

  it("shows the close button in place of the icon while the tab is hovered", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(
      <BarOf tabLabel={(tab) => ({ ...label(tab), icon: <span data-icon={tab.id}>*</span> })} />,
      { router: false },
    );
    const close = screen.container.querySelector<HTMLElement>("[data-tab-close='b']")!;
    const icon = screen.container.querySelector<HTMLElement>("[data-icon='b']")!;
    expect(getComputedStyle(close).opacity).toBe("0");
    expect(getComputedStyle(icon.parentElement!).visibility).toBe("visible");
    await userEvent.hover(screen.getByText("b"));
    await vi.waitFor(() => expect(getComputedStyle(close).opacity).toBe("1"));
    expect(getComputedStyle(icon.parentElement!).visibility).toBe("hidden");
  });
});

describe("menu and add", () => {
  it("asks for the tab's menu at the pointer on a right click, without showing the tab", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    const onTabContextMenu = vi.fn();
    await using screen = await render(<BarOf onTabContextMenu={onTabContextMenu} />, {
      router: false,
    });
    await userEvent.click(screen.getByText("b"), { button: "right" });
    expect(onTabContextMenu).toHaveBeenCalledOnce();
    const [tab, position] = onTabContextMenu.mock.calls[0]!;
    expect(tab.id).toBe("b");
    expect(position.x).toBeGreaterThan(0);
    const location = findLayoutTab(
      useLayoutStore.getState().layout,
      (candidate) => candidate.id === "b",
    );
    expect(location?.pane.activeTabId).toBe("a");
  });

  it("puts a + button after the last tab and calls onAdd for the pane", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    const onAdd = vi.fn();
    await using screen = await render(<BarOf onAdd={onAdd} />, { router: false });
    const add = screen.getByRole("button", { name: "New tab" });
    const lastTab = screen.container.querySelector("[data-layout-pane-tab='b']")!;
    expect(add.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(
      lastTab.getBoundingClientRect().right,
    );
    await add.click();
    expect(onAdd).toHaveBeenCalledWith("w0c0p0");
  });

  it("has no + button when the caller offers no way to add a tab", async () => {
    using _layout = openLayout([[[["a"]]]]);
    await using screen = await render(<BarOf />, { router: false });
    expect(screen.container.querySelector("[data-layout-tab-add]")).toBeNull();
  });
});

describe("long titles and overflow", () => {
  it("truncates a long title inside a tab no wider than 12rem", async () => {
    using _layout = openLayout([[[["a"]]]]);
    const title = "Investigate why the nightly release channel mapping drifts after a restart";
    await using screen = await render(
      <BarOf tabLabel={() => ({ title, tooltip: title })} width={600} />,
      { router: false },
    );
    const tab = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab]")!;
    const text = screen.getByText(title).element() as HTMLElement;
    expect(tab.getBoundingClientRect().width).toBeLessThanOrEqual(192);
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
  });

  it("scrolls when tabs do not fit, fades the edge and reveals the active tab", async () => {
    const names = Array.from({ length: 24 }, (_, index) => `tab-${index}`);
    using _layout = openLayout([[[names]]]);
    const layout = useLayoutStore.getState().layout;
    layout.workspaces[0]!.columns[0]!.panes[0]!.activeTabId = "tab-23";
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<BarOf width={420} />, { router: false });
    const strip = screen.container.querySelector<HTMLElement>("[data-layout-tab-strip]")!;
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(strip.hasAttribute("data-overflowing")).toBe(true);
    await vi.waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(0));
    const bounds = strip.getBoundingClientRect();
    const active = screen.container
      .querySelector("[data-layout-pane-tab='tab-23']")!
      .getBoundingClientRect();
    expect(active.right).toBeLessThanOrEqual(bounds.right + 1);
  });

  it("turns the wheel into sideways scrolling over an overflowing strip", async () => {
    const names = Array.from({ length: 24 }, (_, index) => `tab-${index}`);
    using _layout = openLayout([[[names]]]);
    await using screen = await render(<BarOf width={420} />, { router: false });
    const strip = screen.container.querySelector<HTMLElement>("[data-layout-tab-strip]")!;
    const before = strip.scrollLeft;
    strip.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    expect(strip.scrollLeft).toBeGreaterThan(before);
  });

  it("does not fade a strip whose tabs fit", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf width={600} />, { router: false });
    const strip = screen.container.querySelector<HTMLElement>("[data-layout-tab-strip]")!;
    expect(strip.hasAttribute("data-overflowing")).toBe(false);
  });
});

describe("placements", () => {
  it("lifts the top pane's bar into a 40px window bar with concave corners on the active tab", async () => {
    using _layout = openLayout([[[["a", "b", "c"]]]]);
    const layout = useLayoutStore.getState().layout;
    layout.workspaces[0]!.columns[0]!.panes[0]!.activeTabId = "b";
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<BarOf placement="window" />, { router: false });
    const bar = screen.container.querySelector<HTMLElement>("[data-layout-tab-bar='window']")!;
    expect(bar.getBoundingClientRect().height).toBe(40);
    const active = screen.container.querySelector("[data-layout-pane-tab='b']")!;
    expect(active.querySelectorAll("[data-layout-tab-corner]")).toHaveLength(2);
    expect(screen.container.querySelectorAll("[data-layout-tab-corner]")).toHaveLength(2);
  });

  it("gives the first tab no leading corner, so it meets the surface square", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf placement="window" />, { router: false });
    const corners = [...screen.container.querySelectorAll("[data-layout-tab-corner]")].map(
      (corner) => corner.getAttribute("data-layout-tab-corner"),
    );
    expect(corners).toEqual(["end"]);
  });

  it("keeps a pane's own bar at 32px, with the same concave corners on its active tab", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<BarOf placement="pane" />, { router: false });
    const bar = screen.container.querySelector<HTMLElement>("[data-layout-tab-bar='pane']")!;
    expect(bar.getBoundingClientRect().height).toBe(32);
    expect(screen.container.querySelectorAll("[data-layout-tab-corner]")).toHaveLength(1);
  });

  it("leaves room for native window chrome through the insets it is given", async () => {
    using _layout = openLayout([[[["a"]]]]);
    await using screen = await render(
      <BarOf placement="window" leadingInset="4.75rem" trailingInset="90px" />,
      { router: false },
    );
    const bar = screen.container.querySelector<HTMLElement>("[data-layout-tab-bar]")!;
    expect(getComputedStyle(bar).paddingInlineStart).toBe("76px");
    expect(getComputedStyle(bar).paddingInlineEnd).toBe("90px");
  });
  it("clears the collapsed sidebar's toggle at the leading edge, and nothing outside a sidebar shell", async () => {
    using _layout = openLayout([[[["a"]]]]);
    const inset = (state: "collapsed" | undefined) => (
      <div
        data-sidebar-state={state}
        style={{ "--workspace-titlebar-content-left": "76px" } as React.CSSProperties}
      >
        <BarOf placement="window" />
      </div>
    );
    await using collapsed = await render(inset("collapsed"), { router: false });
    const collapsedBar = collapsed.container.querySelector<HTMLElement>("[data-layout-tab-bar]")!;
    expect(getComputedStyle(collapsedBar).paddingInlineStart).toBe("76px");
    await using bare = await render(inset(undefined), { router: false });
    const bareBar = bare.container.querySelector<HTMLElement>("[data-layout-tab-bar]")!;
    expect(getComputedStyle(bareBar).paddingInlineStart).not.toBe("76px");
  });
});
