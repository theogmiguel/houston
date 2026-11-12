import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { buildLayout } from "./layoutFixtures";
import { useLayoutPane } from "./layoutPaneContext";
import { useLayoutStore } from "./layoutStore";
import { LayoutWorkspaceStrip, type LayoutWorkspaceStripProps } from "./WorkspaceStrip";

const mounts = new Map<string, number>();

function resetSession() {
  finishWorkspaceSwitch();
  useLayoutStore.getState().setOverviewOpen(false);
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ maximizedTabId: null, unseenTabIds: new Set() });
  configureMotion({ off: false });
  mounts.clear();
}

function openLayout(shape: string[][][][]): Disposable {
  resetSession();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: resetSession };
}

/** Counts how many times its tab's content mounted, and shows what the pane told it. */
function Probe({ id }: { id: string }) {
  const pane = useLayoutPane();
  const [countMount] = useState(() => (element: HTMLElement | null) => {
    if (element) mounts.set(id, (mounts.get(id) ?? 0) + 1);
  });
  return (
    <div
      ref={countMount}
      data-body={id}
      data-visible={String(pane.visible)}
      data-near={String(pane.near)}
      data-kept={String(pane.kept)}
      style={{ flex: 1 }}
    >
      {id}
    </div>
  );
}

function Harness(props: Partial<LayoutWorkspaceStripProps>) {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        renderTab={(tab) => <Probe id={tab.id} />}
        tabLabel={(tab) => ({ title: tab.id })}
        retainTab={() => true}
        {...props}
      />
    </div>
  );
}

const body = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-body='${id}']`);

describe("tabs kept mounted off screen", () => {
  it("keeps a tab the pane switched away from mounted, hidden, and shows the same instance on return", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    expect(body(screen.container, "a")?.dataset.visible).toBe("true");
    await act(() => useLayoutStore.getState().focusTab("b"));
    expect(body(screen.container, "a")?.dataset.visible).toBe("false");
    expect(body(screen.container, "b")?.dataset.visible).toBe("true");
    await act(() => useLayoutStore.getState().focusTab("a"));
    expect(body(screen.container, "a")?.dataset.visible).toBe("true");
    expect(mounts.get("a")).toBe(1);
    expect(mounts.get("b")).toBe(1);
  });

  it("takes a hidden tab off the screen and out of input", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    await act(() => useLayoutStore.getState().focusTab("b"));
    const hidden = body(screen.container, "a")!.closest<HTMLElement>("[data-layout-pane-body]")!;
    expect(hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.getBoundingClientRect().right).toBeLessThanOrEqual(0);
  });

  it("keeps the focused workspace's tabs mounted through a switch to another", async () => {
    using _layout = openLayout([[[["a"]]], [[["b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    await act(() => useLayoutStore.getState().focusWorkspace("w1"));
    await vi.waitFor(() => expect(body(screen.container, "b")?.dataset.visible).toBe("true"));
    expect(body(screen.container, "a")).not.toBeNull();
    expect(body(screen.container, "a")?.dataset.visible).toBe("false");
    expect(mounts.get("a")).toBe(1);
  });

  it("lets go of a hidden tab once it closes", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness />, { router: false });
    await act(() => useLayoutStore.getState().focusTab("b"));
    await act(() => useLayoutStore.getState().closeTab("a"));
    expect(body(screen.container, "a")).toBeNull();
    expect(body(screen.container, "b")?.dataset.visible).toBe("true");
  });

  it("unmounts a tab that is not retained when it stops being shown", async () => {
    using _layout = openLayout([[[["a", "b"]]]]);
    await using screen = await render(<Harness retainTab={() => false} />, { router: false });
    await act(() => useLayoutStore.getState().focusTab("b"));
    expect(body(screen.container, "a")).toBeNull();
  });
});

describe("tabs near the camera", () => {
  /** Ten 500px columns: a strip five windows long. */
  function openLongStrip(): Disposable {
    resetSession();
    const layout = buildLayout([[..."abcdefghij"].map((name) => [[name]])]);
    for (const column of layout.workspaces[0]!.columns) column.width = 0.5;
    layout.workspaces[0]!.cameraWidth = 1000;
    useLayoutStore.getState().setLayoutFromServer(layout);
    return { [Symbol.dispose]: resetSession };
  }

  it("marks the panes within a window of the camera near, and the rest not", async () => {
    using _layout = openLongStrip();
    await using screen = await render(<Harness />, { router: false });
    expect(body(screen.container, "a")?.dataset.near).toBe("true");
    expect(body(screen.container, "e")?.dataset.near).toBe("true");
    expect(body(screen.container, "j")?.dataset.near).toBe("false");
  });

  it("brings a pane near as the strip scrolls toward it", async () => {
    using _layout = openLongStrip();
    await using screen = await render(<Harness />, { router: false });
    const scroller = screen.container.querySelector<HTMLElement>("[data-layout-strip]")!;
    await act(() => {
      scroller.scrollLeft = 4000;
    });
    await vi.waitFor(() => expect(body(screen.container, "j")?.dataset.near).toBe("true"));
  });

  it("keeps the focused pane's tab and the recent ones kept, and lets the far rest go", async () => {
    using _layout = openLongStrip();
    await using screen = await render(<Harness />, { router: false });
    expect(body(screen.container, "a")?.dataset.kept).toBe("true");
    expect(body(screen.container, "j")?.dataset.kept).toBe("false");
  });
});
