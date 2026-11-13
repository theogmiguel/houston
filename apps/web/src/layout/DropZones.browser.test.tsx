import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { LayoutDropZones } from "./DropZones";
import { cancelLayoutDrag, moveLayoutDrag } from "./layoutDrag";
import { buildLayout } from "./layoutFixtures";
import { useLayoutStore } from "./layoutStore";
import { beginLayoutTabDrag } from "./layoutTabDrag";
import type { LayoutTabLabel } from "./PaneTabBar";
import { LayoutWorkspaceStrip } from "./WorkspaceStrip";

const label = (tab: { id: string }): LayoutTabLabel => ({ title: tab.id });

function Scene() {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        tabLabel={label}
        renderTab={(tab) => <div data-body={tab.id} style={{ flex: 1 }} />}
      />
      <LayoutDropZones tabLabel={label} />
    </div>
  );
}

const SOURCE = { kind: "tab", tabId: "a" } as const;
const overlay = () => document.querySelector<HTMLElement>("[data-layout-drag-overlay]");
const pane = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-layout-pane-id='${id}']`)!.getBoundingClientRect();

/** Puts a layout in the store for one test; a drag in flight and the layout end with the test. */
function openLayout(shape: string[][][][] = [[[["a", "b"]], [["c"]]]]): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return {
    [Symbol.dispose]: () => {
      cancelLayoutDrag();
      useLayoutStore.getState().reset();
    },
  };
}

describe("drag overlay", () => {
  it("draws nothing until a drag starts and nothing after it is cancelled", async () => {
    using _layout = openLayout();
    await using _screen = await render(<Scene />, { router: false });
    expect(overlay()).toBeNull();
    await act(() => moveLayoutDrag(SOURCE, { x: 700, y: 300 }));
    expect(overlay()).not.toBeNull();
    await act(() => cancelLayoutDrag());
    expect(overlay()).toBeNull();
  });

  it("lifts a tilted copy of the dragged tab under the pointer", async () => {
    using _layout = openLayout();
    await using _screen = await render(<Scene />, { router: false });
    await act(() => moveLayoutDrag(SOURCE, { x: 700, y: 300 }));
    const ghost = overlay()!.querySelector<HTMLElement>("[data-layout-drag-ghost]")!;
    expect(ghost.textContent).toBe("a");
    expect(getComputedStyle(ghost).transform).not.toBe("none");
  });

  it("grips every side of every pane", async () => {
    using _layout = openLayout();
    await using _screen = await render(<Scene />, { router: false });
    await act(() => moveLayoutDrag(SOURCE, { x: 700, y: 300 }));
    expect(overlay()!.querySelectorAll("[data-layout-drop-grip]")).toHaveLength(8);
  });
});

describe("drop zones", () => {
  async function dragTo(x: number, y: number) {
    await act(() => moveLayoutDrag(SOURCE, { x, y }));
    return {
      zone: overlay()!.querySelector<HTMLElement>("[data-layout-drop-zone]"),
      pill: overlay()!.querySelector<HTMLElement>("[data-layout-drop-pill]")?.textContent ?? null,
      activeGrip:
        overlay()!
          .querySelector("[data-layout-drop-grip][data-active]")
          ?.getAttribute("data-layout-drop-grip") ?? null,
    };
  }

  it("previews a tab drop over another pane's tab bar", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c1p0");
    const result = await dragTo(target.left + 100, target.top + 20);
    expect(result.zone).not.toBeNull();
    expect(result.pill).toMatch(/Into|tab|Add/i);
  });

  it("marks the gap between tabs where the dragged tab lands, and no gap over a body", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const mark = () => overlay()!.querySelector<HTMLElement>("[data-layout-drop-insert]");
    const tabB = screen.container
      .querySelector<HTMLElement>("[data-layout-pane-tab='b']")!
      .getBoundingClientRect();
    const source = { kind: "tab", tabId: "c" } as const;
    await act(() => moveLayoutDrag(source, { x: tabB.left + 4, y: tabB.top + tabB.height / 2 }));
    expect(Math.abs(mark()!.getBoundingClientRect().left + 1 - tabB.left)).toBeLessThan(1.5);
    await act(() => moveLayoutDrag(source, { x: tabB.right - 4, y: tabB.top + tabB.height / 2 }));
    expect(Math.abs(mark()!.getBoundingClientRect().left + 1 - tabB.right)).toBeLessThan(1.5);
    const target = pane(screen.container, "w0c0p0");
    await act(() => moveLayoutDrag(source, { x: target.left + 40, y: target.bottom - 60 }));
    expect(mark()).toBeNull();
  });

  it.each([
    ["left", 0.1, 0.5],
    ["right", 0.9, 0.5],
    ["up", 0.5, 0.15],
    ["down", 0.5, 0.95],
  ] as const)("previews a split to the %s over the pane's body", async (side, fx, fy) => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c1p0");
    const result = await dragTo(
      target.left + target.width * fx,
      target.top + 48 + (target.height - 48) * fy,
    );
    expect(result.zone).not.toBeNull();
    expect(result.activeGrip).toBe(side);
    const zone = result.zone!.getBoundingClientRect();
    if (side === "left" || side === "right") expect(zone.width).toBeLessThan(target.width / 2);
    else expect(zone.height).toBeLessThan(target.height / 2);
  });

  it.each(["left", "right"] as const)(
    "previews a new column at the strip's %s edge",
    async (edge) => {
      using _layout = openLayout();
      await using _screen = await render(<Scene />, { router: false });
      await dragTo(edge === "left" ? 2 : 998, 300);
      expect(
        overlay()!.querySelector(`[data-layout-drop-extend='${edge}'][data-active]`),
      ).not.toBeNull();
      expect(overlay()!.querySelector("[data-layout-drop-pill]")?.textContent).toMatch(/column/i);
    },
  );

  it("previews a new workspace at the strip's bottom edge", async () => {
    // The bottom edge starts the empty workspace that waits below the last one.
    using _layout = openLayout([[[["a", "b"]], [["c"]]], []]);
    await using screen = await render(<Scene />, { router: false });
    const strip = screen.container.querySelector("[data-layout-strip]")!.getBoundingClientRect();
    await dragTo(strip.left + 500, strip.bottom - 2);
    expect(
      overlay()!.querySelector("[data-layout-drop-extend='bottom'][data-active]"),
    ).not.toBeNull();
  });

  it("previews no drop where the layout would not change", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const own = pane(screen.container, "w0c1p0");
    const lone = await dragTo(own.left + 50, own.top + 20);
    expect(lone.zone).not.toBeNull();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    await act(() => cancelLayoutDrag());
    const result = await dragTo(500, 300);
    expect(result.zone).toBeNull();
  });
});

describe("dragging a tab", () => {
  it("starts past the threshold, moves the tab to another pane on release and swallows the click", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const tab = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab='a']")!;
    const from = tab.getBoundingClientRect();
    const target = pane(screen.container, "w0c1p0");
    const down = new PointerEvent("pointerdown", {
      pointerId: 5,
      button: 0,
      pointerType: "mouse",
      clientX: from.left + 20,
      clientY: from.top + 10,
      bubbles: true,
    });
    await act(() => beginLayoutTabDrag(down as unknown as React.PointerEvent, "a"));
    const move = (x: number, y: number) =>
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 5,
          pointerType: "mouse",
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    await act(() => move(from.left + 22, from.top + 10));
    expect(overlay()).toBeNull();
    await act(() => move(target.left + 100, target.top + 20));
    expect(overlay()).not.toBeNull();
    await act(() =>
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 5,
          pointerType: "mouse",
          clientX: target.left + 100,
          clientY: target.top + 20,
          bubbles: true,
        }),
      ),
    );
    expect(overlay()).toBeNull();
    const tabs = useLayoutStore
      .getState()
      .layout.workspaces[0]!.columns.map((column) =>
        column.panes.flatMap((p) => p.tabs.map((t) => t.id)),
      );
    expect(tabs).toEqual([["b"], ["c", "a"]]);
  });

  it("cancels on Escape and leaves the layout alone", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />, { router: false });
    const tab = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab='a']")!;
    const from = tab.getBoundingClientRect();
    const down = new PointerEvent("pointerdown", {
      pointerId: 6,
      button: 0,
      pointerType: "mouse",
      clientX: from.left + 20,
      clientY: from.top + 10,
      bubbles: true,
    });
    await act(() => beginLayoutTabDrag(down as unknown as React.PointerEvent, "a"));
    await act(() =>
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 6,
          pointerType: "mouse",
          clientX: 700,
          clientY: 300,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(overlay()).not.toBeNull();
    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(overlay()).toBeNull();
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.panes[0]!.tabs).toHaveLength(
      2,
    );
  });
});
