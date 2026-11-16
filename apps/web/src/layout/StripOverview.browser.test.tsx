import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { buildLayout } from "./layoutFixtures";
import { selectFocusedTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutOverview } from "./LayoutOverview";
import { getOverviewPhase, setOverviewPhase } from "./overviewPhase";
import { LayoutWorkspaceStrip } from "./WorkspaceStrip";

function resetSession() {
  finishWorkspaceSwitch();
  useLayoutStore.getState().setOverviewOpen(false);
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ maximizedTabId: null, unseenTabIds: new Set() });
  setOverviewPhase("closed");
  configureMotion({ off: false });
}

function openLayout(shape: string[][][][]): Disposable {
  resetSession();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  return { [Symbol.dispose]: resetSession };
}

function Harness() {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        renderTab={(tab) => (
          <div data-body={tab.id} style={{ flex: 1 }}>
            {tab.id}
          </div>
        )}
        tabLabel={(tab) => ({ title: tab.id })}
      />
      <LayoutOverview />
    </div>
  );
}

const TWO_WORKSPACES = [[[["a"]], [["b"]]], [[["c"]]]];
const focusedTabId = () => selectFocusedTab(useLayoutStore.getState().layout)?.id;
const open = () => useLayoutStore.getState().setOverviewOpen(true);

describe("the overview on the strip", () => {
  it("shows the panes of every workspace on one stage and settles open", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using screen = await render(<Harness />, { router: false });
    expect(screen.container.querySelector("[data-layout-overview]")).toBeNull();
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    expect(screen.container.querySelector("[data-layout-overview]")).not.toBeNull();
    for (const id of ["a", "b", "c"]) {
      expect(screen.container.querySelector(`[data-body='${id}']`)).not.toBeNull();
    }
    expect(screen.container.querySelectorAll("[data-overview-pane]")).toHaveLength(3);
    expect(screen.container.querySelectorAll("[data-overview-workspace]")).toHaveLength(2);
  });

  it("keeps the panes beneath it from taking input", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    for (const frame of screen.container.querySelectorAll("[data-layout-pane-frame]")) {
      expect(frame.hasAttribute("inert")).toBe(true);
    }
  });

  it("moves the selection with the keys, opens the picked pane on Enter and gives the strip back", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    await userEvent.keyboard("l");
    expect(focusedTabId()).toBe("b");
    await userEvent.keyboard("j");
    expect(focusedTabId()).toBe("c");
    await userEvent.keyboard("{Enter}");
    expect(useLayoutStore.getState().overviewOpen).toBe(false);
    await expect.poll(() => getOverviewPhase()).toBe("closed");
    expect(screen.container.querySelector("[data-layout-overview]")).toBeNull();
    expect(focusedTabId()).toBe("c");
    const stage = screen.container.querySelector<HTMLElement>("[data-layout-stage]")!;
    expect(stage.style.transform).toBe("");
    expect(getComputedStyle(stage).position).toBe("relative");
  });

  it("closes on Escape without changing focus", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using _screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => getOverviewPhase()).toBe("closed");
    expect(focusedTabId()).toBe("a");
  });

  it("picks the pane that is clicked", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    const target = screen.container.querySelector<HTMLElement>("[data-overview-pane='w1c0p0']")!;
    await userEvent.click(target);
    expect(focusedTabId()).toBe("c");
    await expect.poll(() => getOverviewPhase()).toBe("closed");
  });

  it("opens and closes at once under reduced motion", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    configureMotion({ off: true });
    await using _screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    useLayoutStore.getState().setOverviewOpen(false);
    await expect.poll(() => getOverviewPhase()).toBe("closed");
  });

  it("lists an empty focused workspace as a dashed row", async () => {
    using _layout = openLayout([[]]);
    await using screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    expect(screen.container.querySelectorAll("[data-overview-workspace]")).toHaveLength(1);
  });

  it("drags a pane above the first row into a workspace of its own", async () => {
    using _layout = openLayout(TWO_WORKSPACES);
    await using screen = await render(<Harness />, { router: false });
    open();
    await expect.poll(() => getOverviewPhase()).toBe("open");
    const pane = screen.container.querySelector<HTMLElement>("[data-overview-pane='w0c1p0']")!;
    const host = pane.closest<HTMLElement>("[data-layout-stage]")!.parentElement!;
    const tabsOf = (workspace: { columns: { panes: { activeTabId: string | null }[] }[] }) =>
      workspace.columns.flatMap((column) => column.panes.map((p) => p.activeTabId));
    await userEvent.dragAndDrop(pane, host, { targetPosition: { x: 500, y: 6 } });
    const workspaces = useLayoutStore.getState().layout.workspaces.map(tabsOf);
    expect(workspaces[0]).toEqual(["b"]);
    expect(workspaces.flat().toSorted()).toEqual(["a", "b", "c"]);
  });
});
