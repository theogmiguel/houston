import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { buildLayout } from "./layoutFixtures";
import { findLayoutTab, selectFocusedPane } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import type { LayoutTabLabel } from "./PaneTabBar";
import { LayoutWorkspaceStrip, type LayoutWorkspaceStripProps } from "./WorkspaceStrip";

const POINTER_ID = 11;

function resetSession() {
  finishWorkspaceSwitch();
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ maximizedTabId: null, unseenTabIds: new Set() });
  configureMotion({ off: false });
}

/** Puts a layout in the store for one test and clears every session value when the test ends. */
function openLayout(shape: string[][][][]): Disposable {
  resetSession();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: resetSession };
}

function Harness({
  width = 1000,
  height = 600,
  ...props
}: Partial<LayoutWorkspaceStripProps> & { width?: number; height?: number }) {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width, height, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        renderTab={(tab, context) => (
          <div data-body={tab.id} data-visible={context.visible} style={{ flex: 1 }}>
            {tab.id}
          </div>
        )}
        tabLabel={(tab): LayoutTabLabel => ({ title: tab.id })}
        {...props}
      />
    </div>
  );
}

const frames = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-layout-pane-frame]")].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  );
const frameOf = (container: HTMLElement, paneId: string) =>
  container.querySelector<HTMLElement>(`[data-layout-pane-id='${paneId}']`)!;
const rect = (element: Element) => element.getBoundingClientRect();
const separators = (container: HTMLElement, orientation: "vertical" | "horizontal") =>
  container.querySelectorAll<HTMLElement>(`[role='separator'][aria-orientation='${orientation}']`);

function pointer(type: string, target: EventTarget, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("one pane", () => {
  it("fills the strip, with its tabs in a window bar above the surface and its tab's content on it", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const frame = frameOf(screen.container, "w0c0p0");
    expect(rect(frame)).toMatchObject({ left: 0, top: 0, width: 1000, height: 600 });
    const bar = frame.querySelector("[data-layout-tab-bar]")!;
    expect(bar.getAttribute("data-layout-tab-bar")).toBe("window");
    expect(rect(bar).height).toBe(40);
    const surface = frame.querySelector("[data-layout-pane-surface]")!;
    expect(rect(surface).top).toBe(40);
    const body = screen.container.querySelector("[data-body='a']")!;
    expect(rect(body).top).toBeGreaterThanOrEqual(40);
    expect(screen.container.querySelector("[data-body='b']")).toBeNull();
    expect(separators(screen.container, "vertical")).toHaveLength(0);
    expect(separators(screen.container, "horizontal")).toHaveLength(0);
  });

  it("shows a pane's tab content when its tab is chosen", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    await userEvent.click(screen.getByText("b", { exact: true }).first());
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-body='b']")).not.toBeNull(),
    );
    expect(screen.container.querySelector("[data-body='a']")).toBeNull();
  });
});

describe("columns and stacked panes", () => {
  it("lays columns side by side with one gutter between them", async () => {
    using _layout = openLayout([[[["a"]], [["b"]], [["c"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const [first, second, third] = frames(screen.container);
    expect(rect(first!).right + 4).toBeCloseTo(rect(second!).left - 4, 0);
    expect(rect(second!).left - rect(first!).right).toBe(8);
    expect(rect(third!).left - rect(second!).right).toBe(8);
    expect(rect(third!).right).toBe(1000);
    for (const frame of frames(screen.container)) {
      expect(
        frame.querySelector("[data-layout-tab-bar]")!.getAttribute("data-layout-tab-bar"),
      ).toBe("window");
    }
    expect(separators(screen.container, "vertical")).toHaveLength(3);
  });

  it("stacks a column's panes, the lower one with its bar inside its own surface", async () => {
    using _layout = openLayout([[[["a"], ["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const top = frameOf(screen.container, "w0c0p0");
    const bottom = frameOf(screen.container, "w0c0p1");
    expect(rect(bottom).top - rect(top).bottom).toBe(8);
    expect(top.querySelector("[data-layout-tab-bar]")!.getAttribute("data-layout-tab-bar")).toBe(
      "window",
    );
    const lower = bottom.querySelector("[data-layout-tab-bar]")!;
    expect(lower.getAttribute("data-layout-tab-bar")).toBe("pane");
    expect(lower.closest("[data-layout-pane-surface]")).not.toBeNull();
    expect(rect(lower).height).toBe(30);
    expect(separators(screen.container, "horizontal")).toHaveLength(1);
  });

  it("keeps a tab's content mounted when its pane moves to another column", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const body = screen.container.querySelector("[data-body='a']")!;
    await act(() => {
      useLayoutStore.getState().moveTab("a", { kind: "split", paneId: "w0c1p0", side: "down" });
    });
    expect(screen.container.querySelector("[data-body='a']")).toBe(body);
  });
});

describe("focus", () => {
  it("rings only the focused pane, and moves the ring to a pane pressed on", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const surface = (id: string) =>
      frameOf(screen.container, id).querySelector<HTMLElement>("[data-layout-pane-surface]")!;
    expect(surface("w0c0p0").hasAttribute("data-focused")).toBe(true);
    expect(surface("w0c1p0").hasAttribute("data-focused")).toBe(false);
    const focusedRing = getComputedStyle(surface("w0c0p0")).boxShadow;
    expect(getComputedStyle(surface("w0c1p0")).boxShadow).not.toBe(focusedRing);
    const body = screen.container.querySelector("[data-body='b']")!;
    const at = rect(body);
    await act(() => pointer("pointerdown", body, at.left + 10, at.top + 10));
    expect(selectFocusedPane(useLayoutStore.getState().layout)?.id).toBe("w0c1p0");
    expect(surface("w0c1p0").hasAttribute("data-focused")).toBe(true);
    expect(surface("w0c0p0").hasAttribute("data-focused")).toBe(false);
  });

  it("tells a tab's content whether its pane is focused", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    const seen = new Map<string, boolean>();
    await using _screen = await render(
      <Harness
        renderTab={(tab, context) => {
          seen.set(tab.id, context.focused);
          return <div data-body={tab.id} />;
        }}
      />,
      { router: false },
    );
    expect(Object.fromEntries(seen)).toEqual({ a: true, b: false });
  });
});

describe("empty", () => {
  it("shows the caller's empty content in a lone pane for a workspace with no tabs", async () => {
    using _layout = openLayout([[]]);
    await using screen = await render(<Harness empty={<p data-launcher="">Start something</p>} />, {
      router: false,
    });
    const empty = screen.container.querySelector<HTMLElement>("[data-layout-empty-workspace]")!;
    expect(rect(empty)).toMatchObject({ width: 1000, height: 600 });
    expect(empty.querySelector("[data-launcher]")).not.toBeNull();
    expect(screen.container.querySelectorAll("[data-layout-tab-strip]")).toHaveLength(0);
  });

  it("shows a pane with no active tab as empty rather than blank", async () => {
    using _layout = openLayout([[[["a"]]]]);
    const layout = useLayoutStore.getState().layout;
    layout.workspaces[0]!.columns[0]!.panes[0]!.activeTabId = null;
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<Harness />, { router: false });
    expect(screen.container.querySelector("[data-layout-empty-pane]")).not.toBeNull();
    expect(screen.container.querySelector("[data-body]")).toBeNull();
  });
});

describe("narrow window", () => {
  it("shows only the focused pane, at full size, and no resize handles", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness narrow width={480} />, { router: false });
    expect(frames(screen.container)).toHaveLength(1);
    expect(rect(frames(screen.container)[0]!)).toMatchObject({ width: 480, height: 600 });
    expect(screen.container.querySelector("[data-body='b']")).toBeNull();
    expect(separators(screen.container, "vertical")).toHaveLength(0);
  });

  it("shows the maximized pane alone", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    await act(() => {
      useLayoutStore.getState().focusTab("b");
      useLayoutStore.getState().toggleMaximizedTab("b");
    });
    expect(frames(screen.container)).toHaveLength(1);
    expect(screen.container.querySelector("[data-body='b']")).not.toBeNull();
  });
});

describe("scrolling strip", () => {
  it("scrolls sideways when the columns are wider than the window and reveals a focused column", async () => {
    using _layout = openLayout([[[["a"]], [["b"]], [["c"]], [["d"]]]]);
    const layout = useLayoutStore.getState().layout;
    for (const column of layout.workspaces[0]!.columns) column.width = 0.6;
    layout.workspaces[0]!.cameraWidth = 1000;
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<Harness />, { router: false });
    const scroller = screen.container.querySelector<HTMLElement>("[data-layout-strip]")!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    await act(() => useLayoutStore.getState().focusPane("w0c3p0"));
    // The scroll lands at once; the stage then springs there, so the frame's rect is mid-flight.
    await vi.waitFor(() => expect(scroller.scrollLeft).toBeGreaterThanOrEqual(1399));
  });

  it("marks a pane an agent opened off screen with a dot that brings it in", async () => {
    using _layout = openLayout([[[["a"]], [["b"]], [["c"]], [["d"]]]]);
    const layout = useLayoutStore.getState().layout;
    for (const column of layout.workspaces[0]!.columns) column.width = 0.6;
    layout.workspaces[0]!.cameraWidth = 1000;
    useLayoutStore.getState().setLayoutFromServer(layout);
    await using screen = await render(<Harness />, { router: false });
    await act(() => useLayoutStore.getState().markTabUnseen("d"));
    const dot = screen.container.querySelector<HTMLElement>("[data-layout-unseen-peek='right']")!;
    expect(dot).not.toBeNull();
    await act(() => dot.click());
    expect(selectFocusedPane(useLayoutStore.getState().layout)?.id).toBe("w0c3p0");
  });
});

describe("workspaces", () => {
  it("shows the focused workspace and switches to another", async () => {
    using _layout = openLayout([[[["a"]]], [[["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    expect(screen.container.querySelector("[data-body='a']")).not.toBeNull();
    expect(screen.container.querySelector("[data-body='b']")).toBeNull();
    await act(() => useLayoutStore.getState().focusWorkspace("w1"));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-body='b']")).not.toBeNull(),
    );
    await vi.waitFor(() => expect(screen.container.querySelector("[data-body='a']")).toBeNull());
  });

  it("draws both workspaces while a switch is in motion", async () => {
    using _layout = openLayout([[[["a"]]], [[["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    // The strip treats a route restore in its first frames as not worth animating.
    let polls = 0;
    await vi.waitFor(() => expect(++polls).toBeGreaterThan(12));
    await act(() => useLayoutStore.getState().focusWorkspace("w1"));
    expect(screen.container.querySelector("[data-body='a']")).not.toBeNull();
    expect(screen.container.querySelector("[data-body='b']")).not.toBeNull();
  });

  it("switches without a transition when motion is off", async () => {
    using _layout = openLayout([[[["a"]]], [[["b"]]]]);
    configureMotion({ off: true });
    await using screen = await render(<Harness />, { router: false });
    await act(() => useLayoutStore.getState().focusWorkspace("w1"));
    expect(screen.container.querySelector("[data-body='a']")).toBeNull();
    expect(screen.container.querySelector("[data-body='b']")).not.toBeNull();
  });
});

describe("resizing", () => {
  it("resizes a column by its handle and commits once on release", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const handle = separators(screen.container, "vertical")[0]!;
    const at = rect(handle);
    const x = at.left + at.width / 2;
    const y = at.top + 200;
    const before = rect(frameOf(screen.container, "w0c0p0")).width;
    const widthBefore = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.width;
    await act(() => pointer("pointerdown", handle, x, y));
    await act(() => pointer("pointermove", handle, x + 200, y));
    await vi.waitFor(() =>
      expect(rect(frameOf(screen.container, "w0c0p0")).width).toBeGreaterThan(before + 100),
    );
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.width).toBe(widthBefore);
    expect(screen.container.querySelector("[data-layout-pill]")?.textContent).toMatch(/% width/);
    await act(() => pointer("pointerup", handle, x + 200, y));
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.width).toBeGreaterThan(
      widthBefore,
    );
    expect(screen.container.querySelector("[data-layout-pill]")).toBeNull();
  });

  it("resizes stacked panes by their divider", async () => {
    using _layout = openLayout([[[["a"], ["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const handle = separators(screen.container, "horizontal")[0]!;
    const at = rect(handle);
    const x = at.left + 100;
    const y = at.top + at.height / 2;
    await act(() => pointer("pointerdown", handle, x, y));
    await act(() => pointer("pointermove", handle, x, y + 120));
    await act(() => pointer("pointerup", handle, x, y + 120));
    const [first, second] = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.panes;
    expect(first!.size).toBeGreaterThan(0.5);
    expect(first!.size + second!.size).toBeCloseTo(1, 5);
  });

  it("steps a column with the arrow keys", async () => {
    using _layout = openLayout([[[["a"]], [["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const handle = separators(screen.container, "vertical")[0]!;
    handle.focus();
    const before = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.width;
    await userEvent.keyboard("{ArrowRight}");
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.width).not.toBe(before);
  });
});

describe("motion and themes", () => {
  it("drops every transition when motion is off", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    configureMotion({ off: true });
    await using screen = await render(<Harness />, { router: false });
    const tab = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab]")!;
    expect(getComputedStyle(tab).transitionProperty).toBe("none");
    const surface = screen.container.querySelector<HTMLElement>("[data-layout-pane-surface]")!;
    expect(getComputedStyle(surface).transitionProperty).toBe("none");
  });

  it("eases tab feedback on the feedback role when motion is on", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    const tab = screen.container.querySelector<HTMLElement>("[data-layout-pane-tab]")!;
    expect(getComputedStyle(tab).transitionDuration).toBe("0.1s");
  });

  it.each(["light", "dark"] as const)(
    "paints the surface with the pane token in the %s theme",
    async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      try {
        using _layout = openLayout([[[["a", "b"]]]]);
        await using screen = await render(
          <>
            <Harness />
            <span data-probe="" style={{ background: "var(--pane)" }} />
            <span data-probe-bar="" style={{ background: "var(--app-chrome-background)" }} />
          </>,
          { router: false },
        );
        const surface = screen.container.querySelector<HTMLElement>("[data-layout-pane-surface]")!;
        const probe = screen.container.querySelector<HTMLElement>("[data-probe]")!;
        expect(getComputedStyle(surface).backgroundColor).toBe(
          getComputedStyle(probe).backgroundColor,
        );
        const bar = screen.container.querySelector<HTMLElement>("[data-layout-tab-bar='window']")!;
        const chrome = screen.container.querySelector<HTMLElement>("[data-probe-bar]")!;
        expect(getComputedStyle(bar).backgroundColor).toBe(
          getComputedStyle(chrome).backgroundColor,
        );
        const active = screen.container.querySelector<HTMLElement>(
          "[data-layout-pane-tab][data-active]",
        )!;
        expect(getComputedStyle(active).backgroundColor).toBe(
          getComputedStyle(probe).backgroundColor,
        );
        expect(
          findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "a"),
        ).not.toBeNull();
      } finally {
        document.documentElement.classList.remove("dark");
      }
    },
  );
});
