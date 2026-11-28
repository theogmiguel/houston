import { EnvironmentId, ThreadId, type OrchestrationV2TurnItem } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { LayoutDropZones } from "../../layout/DropZones";
import { cancelLayoutDrag } from "../../layout/layoutDrag";
import { buildLayout } from "../../layout/layoutFixtures";
import { findLayoutSurfaceTabs } from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import type { LayoutTabLabel } from "../../layout/PaneTabBar";
import { useLayoutSurfaceSync } from "../../layout/surfaceSync";
import { LayoutWorkspaceStrip } from "../../layout/WorkspaceStrip";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { TimelineFileChangeCard } from "./TimelineFileChangeCard";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));
const item = {
  type: "file_change",
  fileName: "/work/atlas/CHANGELOG.md",
  additions: 5,
  deletions: 0,
} as FileChangeItem;
const label = (tab: { id: string }): LayoutTabLabel => ({ title: tab.id });

function Scene() {
  const layout = useLayoutStore((state) => state.layout);
  useLayoutSurfaceSync();
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        tabLabel={label}
        renderTab={(tab) => <div data-body={tab.id} style={{ flex: 1 }} />}
      />
      <div style={{ position: "absolute", left: 0, top: 560 }}>
        <TimelineFileChangeCard
          item={item}
          workspaceRoot="/work/atlas"
          threadRef={threadRef}
          onOpenDiff={() => {}}
        />
      </div>
      <LayoutDropZones tabLabel={label} />
    </div>
  );
}

function openLayout(): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]], [["c"]]]]));
  useRightPanelStore.setState({ byThreadKey: {} });
  return {
    [Symbol.dispose]: () => {
      cancelLayoutDrag();
      useLayoutStore.getState().reset();
      useRightPanelStore.setState({ byThreadKey: {} });
    },
  };
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    pointerId: 9,
    pointerType: "mouse",
    button: 0,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
const overlay = () => document.querySelector<HTMLElement>("[data-layout-drag-overlay]");

describe("dragging a changed file into the layout", () => {
  it("opens the file surface beside the pane it is dropped on", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1200, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    using _layout = openLayout();
    await using screen = await render(<Scene />);

    const chip = screen.container.querySelector<HTMLElement>(
      'button[aria-label="Open diff for atlas/CHANGELOG.md"]',
    )!;
    const start = chip.getBoundingClientRect();
    const target = screen.container
      .querySelector<HTMLElement>("[data-layout-pane-id='w0c1p0']")!
      .getBoundingClientRect();
    const point = { x: target.right - 10, y: target.top + 48 + (target.height - 48) / 2 };

    await act(() => chip.dispatchEvent(pointer("pointerdown", start.left + 4, start.top + 4)));
    await act(() => window.dispatchEvent(pointer("pointermove", start.left + 20, start.top + 4)));
    await act(() => window.dispatchEvent(pointer("pointermove", point.x, point.y)));
    expect(overlay()!.querySelector("[data-layout-drop-pill]")?.textContent).toBe("Side by side");
    await act(() => window.dispatchEvent(pointer("pointerup", point.x, point.y)));

    await expect
      .poll(() =>
        findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef).map(({ tab }) =>
          tab.content.kind === "surface" ? tab.content.surfaceId : null,
        ),
      )
      .toEqual(["file:CHANGELOG.md"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([expect.objectContaining({ kind: "file", relativePath: "CHANGELOG.md" })]);
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns).toHaveLength(3);
  });
});
