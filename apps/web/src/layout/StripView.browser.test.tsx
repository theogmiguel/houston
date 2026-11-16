import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { configureMotion } from "../motion/registry";
import { noteUserStripScroll } from "../motion/stripCamera";
import { finishWorkspaceSwitch } from "../motion/workspaceSwitch";
import { buildLayout } from "./layoutFixtures";
import { selectFocusedPane } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutWorkspaceStrip, type LayoutWorkspaceStripProps } from "./WorkspaceStrip";

function resetSession() {
  finishWorkspaceSwitch();
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ maximizedTabId: null, unseenTabIds: new Set() });
  configureMotion({ off: false });
}

/** Four 600px columns in a 1000px window, so the strip scrolls. */
function openScrollingLayout(): Disposable {
  resetSession();
  const layout = buildLayout([[[["a"]], [["b"]], [["c"]], [["d"]]]]);
  for (const column of layout.workspaces[0]!.columns) column.width = 0.6;
  layout.workspaces[0]!.cameraWidth = 1000;
  useLayoutStore.getState().setLayoutFromServer(layout);
  return { [Symbol.dispose]: resetSession };
}

function Harness(props: Partial<LayoutWorkspaceStripProps>) {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        renderTab={(tab) => <div style={{ flex: 1 }}>{tab.id}</div>}
        tabLabel={(tab) => ({ title: tab.id })}
        {...props}
      />
    </div>
  );
}

const focusedPaneId = () => selectFocusedPane(useLayoutStore.getState().layout)?.id;
const scrollerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-layout-strip]")!;

describe("focus follows the view", () => {
  it("moves focus to the column most in view once the user's scroll settles", async () => {
    using _layout = openScrollingLayout();
    await using screen = await render(<Harness />, { router: false });
    const scroller = scrollerOf(screen.container);
    expect(focusedPaneId()).toBe("w0c0p0");
    await act(() => {
      noteUserStripScroll();
      scroller.scrollLeft = 1400;
    });
    await vi.waitFor(() => expect(focusedPaneId()).toBe("w0c3p0"));
  });

  it("does not take a scroll the user did not make for a request to move focus", async () => {
    using _layout = openScrollingLayout();
    const reported: string[][] = [];
    await using screen = await render(
      <Harness onScreenTabsChange={(ids) => reported.push([...ids].toSorted())} />,
      { router: false },
    );
    const scroller = scrollerOf(screen.container);
    await act(() => {
      scroller.scrollLeft = 1400;
    });
    // The report follows the scroll, so by the time it shows the new view the settle has run.
    await vi.waitFor(() => expect(reported.at(-1)).toEqual(["c", "d"]));
    expect(focusedPaneId()).toBe("w0c0p0");
  });
});

describe("panes on screen", () => {
  it("reports the tabs at least half in view, and again once the strip scrolls", async () => {
    using _layout = openScrollingLayout();
    const reported: string[][] = [];
    await using screen = await render(
      <Harness onScreenTabsChange={(ids) => reported.push([...ids].toSorted())} />,
      { router: false },
    );
    expect(reported.at(-1)).toEqual(["a", "b"]);
    await act(() => {
      scrollerOf(screen.container).scrollLeft = 1400;
    });
    await vi.waitFor(() => expect(reported.at(-1)).toEqual(["c", "d"]));
  });

  it("reports nothing while the strip is inactive, and again when it returns", async () => {
    using _layout = openScrollingLayout();
    const reported: string[][] = [];
    const onScreenTabsChange = (ids: ReadonlySet<string>) => reported.push([...ids].toSorted());
    await using screen = await render(
      <Harness onScreenTabsChange={onScreenTabsChange} active={false} />,
      {
        router: false,
      },
    );
    expect(reported.at(-1)).toEqual([]);
    await screen.rerender(<Harness onScreenTabsChange={onScreenTabsChange} active />);
    expect(reported.at(-1)).toEqual(["a", "b"]);
  });

  it("reports nothing once the strip unmounts", async () => {
    using _layout = openScrollingLayout();
    const reported: string[][] = [];
    await using screen = await render(
      <Harness onScreenTabsChange={(ids) => reported.push([...ids].toSorted())} />,
      { router: false },
    );
    expect(reported.at(-1)).toEqual(["a", "b"]);
    await screen.unmount();
    expect(reported.at(-1)).toEqual([]);
  });
});
