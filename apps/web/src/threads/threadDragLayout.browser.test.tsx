import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { LayoutDropZones } from "../layout/DropZones";
import { cancelLayoutDrag, setLayoutThreadDropListener } from "../layout/layoutDrag";
import { setThreadMemberships } from "../layout/threadMembership";
import { buildLayout } from "../layout/layoutFixtures";
import { findLayoutTab, countLayoutTabs } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { beginLayoutTabDrag } from "../layout/layoutTabDrag";
import type { LayoutTabLabel } from "../layout/PaneTabBar";
import { LayoutWorkspaceStrip } from "../layout/WorkspaceStrip";
import { beginThreadDragAt, endThreadDrag } from "./threadDrag";

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

const card = {
  workspaceId: "w9",
  threadId: "t1",
  environmentId: "local",
  projectId: "p1",
  title: "Fix the build",
};

const pane = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-layout-pane-id='${id}']`)!.getBoundingClientRect();

function seed(shape: string[][][][] = [[[["a", "b"]], [["c"]]]]): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return {
    [Symbol.dispose]: () => {
      endThreadDrag();
      cancelLayoutDrag();
      useLayoutStore.getState().reset();
    },
  };
}

function release(point: { x: number; y: number }, pointerId = 1) {
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

const tabWhere = () =>
  findLayoutTab(
    useLayoutStore.getState().layout,
    (tab) =>
      tab.content.kind === "chat" &&
      tab.content.target.kind === "server" &&
      tab.content.target.threadRef.threadId === "t1",
  );

describe("dropping a sidebar card on the layout", () => {
  it("case 3: opens the thread as a tab at the position over a pane's tab bar", async () => {
    using _layout = seed();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c0p0");
    const point = { x: target.left + target.width - 10, y: target.top + 20 };
    await act(() => beginThreadDragAt(card, point, 1));
    expect(document.querySelector("[data-layout-drop-insert]")).not.toBeNull();
    await act(() => release(point));
    const opened = tabWhere();
    expect(opened?.pane.id).toBe("w0c0p0");
    expect(opened?.tabIndex).toBe(2);
    expect(document.querySelector("[data-layout-drag-overlay]")).toBeNull();
  });

  it("case 4: splits a pane and opens the thread in the new half", async () => {
    using _layout = seed();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c1p0");
    const point = {
      x: target.left + target.width * 0.9,
      y: target.top + 48 + (target.height - 48) * 0.5,
    };
    await act(() => beginThreadDragAt(card, point, 1));
    await act(() => release(point));
    const opened = tabWhere();
    expect(opened).not.toBeNull();
    expect(opened?.pane.id).not.toBe("w0c1p0");
    expect(opened?.workspace.columns.length).toBe(3);
  });

  it("case 17: Escape cancels the drop and the layout is unchanged", async () => {
    using _layout = seed();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c0p0");
    const point = { x: target.left + 100, y: target.top + 20 };
    await act(() => beginThreadDragAt(card, point, 1));
    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await act(() => release(point));
    expect(tabWhere()).toBeNull();
    expect(countLayoutTabs(useLayoutStore.getState().layout)).toBe(3);
    expect(document.querySelector("[data-layout-drag-overlay]")).toBeNull();
  });
});

describe("dragging a tab inside the visible workspace", () => {
  it("case 10: still moves a tab onto another pane's tab bar", async () => {
    using _layout = seed();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c1p0");
    const point = { x: target.left + 100, y: target.top + 20 };
    beginLayoutTabDrag(
      { button: 0, pointerType: "mouse", pointerId: 4, clientX: 5, clientY: 5 } as never,
      "a",
    );
    await act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 4,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    });
    await act(() => release(point, 4));
    expect(findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "a")?.pane.id).toBe(
      "w0c1p0",
    );
  });

  it("case 10: a pane-edge drop still splits", async () => {
    using _layout = seed();
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c1p0");
    const point = {
      x: target.left + target.width * 0.9,
      y: target.top + 48 + (target.height - 48) * 0.5,
    };
    beginLayoutTabDrag(
      { button: 0, pointerType: "mouse", pointerId: 4, clientX: 5, clientY: 5 } as never,
      "a",
    );
    await act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 4,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    });
    await act(() => release(point, 4));
    expect(
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === "a")?.workspace.columns
        .length,
    ).toBe(3);
  });
});

describe("dropping a sidebar card on a pane of another workspace", () => {
  const member = (workspaceId: string) =>
    setThreadMemberships(
      [{ environmentId: "local", threadId: "t1", workspaceId, parentThreadId: null }] as never,
      true,
    );

  it("reports the move with where the thread sat, so the caller can offer the way back", async () => {
    using _layout = seed([[[["a"]]], [[["t1", "x"]]]]);
    member("w1");
    const moved = vi.fn();
    using _listener = { [Symbol.dispose]: setLayoutThreadDropListener(moved) };
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c0p0");
    const point = { x: target.left + target.width - 10, y: target.top + 20 };
    await act(() => beginThreadDragAt(card, point, 1));
    await act(() => release(point));
    expect(moved).toHaveBeenCalledExactlyOnceWith({
      threadRef: expect.objectContaining({ threadId: "t1" }),
      title: "Fix the build",
      previous: { workspaceId: "w1", paneId: "w1c0p0", index: 0 },
      targetWorkspaceId: "w0",
    });
  });

  it("reports nothing when the thread already belongs to the visible workspace", async () => {
    using _layout = seed([[[["a", "t1"]]], [[["x"]]]]);
    member("w0");
    const moved = vi.fn();
    using _listener = { [Symbol.dispose]: setLayoutThreadDropListener(moved) };
    await using screen = await render(<Scene />, { router: false });
    const target = pane(screen.container, "w0c0p0");
    const point = { x: target.left + target.width - 10, y: target.top + 20 };
    await act(() => beginThreadDragAt(card, point, 1));
    await act(() => release(point));
    expect(tabWhere()?.pane.id).toBe("w0c0p0");
    expect(moved).not.toHaveBeenCalled();
  });
});
