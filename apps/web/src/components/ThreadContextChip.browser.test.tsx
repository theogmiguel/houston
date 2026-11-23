import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { LayoutDropZones } from "../layout/DropZones";
import { cancelLayoutDrag } from "../layout/layoutDrag";
import { buildLayout } from "../layout/layoutFixtures";
import { findLayoutTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import type { LayoutTabLabel } from "../layout/PaneTabBar";
import { LayoutWorkspaceStrip } from "../layout/WorkspaceStrip";
import { useThreadContextDrop, threadContextDropTargetProps } from "./chat/threadContextDrag";
import { ThreadContextChip } from "./ThreadContextChip";

const environmentId = EnvironmentId.make("local");
const record = { environmentId, threadId: ThreadId.make("t1"), title: "Fix the build" };
const label = (tab: { id: string }): LayoutTabLabel => ({ title: tab.id });

function Composer({ onDrop }: { onDrop: (threadIds: string[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useThreadContextDrop(ref, environmentId, "composer", (refs) =>
    onDrop(refs.map((entry) => entry.threadId)),
  );
  return (
    <div
      ref={ref}
      data-test-composer=""
      style={{ position: "absolute", left: 0, top: 480, width: 400, height: 60, zIndex: 5 }}
      {...threadContextDropTargetProps()}
    />
  );
}

function Scene({ onComposerDrop = () => {} }: { onComposerDrop?: (ids: string[]) => void }) {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <div style={{ width: 1000, height: 600, position: "relative" }}>
      <LayoutWorkspaceStrip
        layout={layout}
        narrow={false}
        tabLabel={label}
        renderTab={(tab) => <div data-body={tab.id} style={{ flex: 1 }} />}
      />
      <div style={{ position: "absolute", left: 0, top: 560 }}>
        <ThreadContextChip record={record} />
      </div>
      <Composer onDrop={onComposerDrop} />
      <LayoutDropZones tabLabel={label} />
    </div>
  );
}

function openLayout(): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]], [["c"]]]]));
  return {
    [Symbol.dispose]: () => {
      cancelLayoutDrag();
      useLayoutStore.getState().reset();
    },
  };
}

const overlay = () => document.querySelector<HTMLElement>("[data-layout-drag-overlay]");
const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    pointerId: 4,
    pointerType: "mouse",
    button: 0,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
const chipThreadTab = () =>
  findLayoutTab(
    useLayoutStore.getState().layout,
    (tab) =>
      tab.content.kind === "chat" &&
      tab.content.target.kind === "server" &&
      tab.content.target.threadRef.threadId === "t1",
  );

async function pressChip(container: HTMLElement) {
  const chip = container.querySelector<HTMLElement>("[aria-label='Thread, Fix the build']")!;
  const rect = chip.getBoundingClientRect();
  const start = { x: rect.left + 6, y: rect.top + 6 };
  await act(() => chip.dispatchEvent(pointer("pointerdown", start.x, start.y)));
  return { chip, start };
}
const move = (x: number, y: number) =>
  act(() => window.dispatchEvent(pointer("pointermove", x, y)));
const release = (x: number, y: number) =>
  act(() => window.dispatchEvent(pointer("pointerup", x, y)));

describe("dragging a thread context chip", () => {
  it("opens the thread beside the pane it is dropped on, once past the threshold", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />);
    const target = screen.container
      .querySelector<HTMLElement>("[data-layout-pane-id='w0c1p0']")!
      .getBoundingClientRect();
    const { start } = await pressChip(screen.container);
    await move(start.x + 2, start.y);
    expect(overlay()).toBeNull();
    const point = { x: target.right - 10, y: target.top + 48 + (target.height - 48) / 2 };
    await move(point.x, point.y);
    expect(overlay()!.querySelector("[data-layout-drop-pill]")?.textContent).toBe("Side by side");
    await release(point.x, point.y);
    expect(overlay()).toBeNull();
    const opened = chipThreadTab();
    expect(opened).not.toBeNull();
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns).toHaveLength(3);
  });

  it("hands the thread to a composer under the pointer instead of the layout", async () => {
    using _layout = openLayout();
    const dropped: string[][] = [];
    await using screen = await render(<Scene onComposerDrop={(ids) => dropped.push(ids)} />);
    const composer = screen.container
      .querySelector<HTMLElement>("[data-test-composer]")!
      .getBoundingClientRect();
    const { start } = await pressChip(screen.container);
    await move(start.x + 20, start.y);
    await move(composer.left + 20, composer.top + 20);
    await release(composer.left + 20, composer.top + 20);
    expect(dropped).toEqual([["t1"]]);
    expect(chipThreadTab()).toBeNull();
  });

  it("cancels on Escape and does not navigate on release", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />);
    const { start } = await pressChip(screen.container);
    await move(start.x + 300, start.y - 200);
    expect(overlay()).not.toBeNull();
    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(overlay()).toBeNull();
    await release(start.x + 300, start.y - 200);
    expect(chipThreadTab()).toBeNull();
    expect(screen.router?.state.location.pathname).toBe("/");
  });

  it("stays a plain link below the threshold", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene />);
    const { chip, start } = await pressChip(screen.container);
    await move(start.x + 2, start.y + 1);
    await release(start.x + 2, start.y + 1);
    expect(overlay()).toBeNull();
    await act(() => chip.click());
    await expect.poll(() => screen.router?.state.location.pathname).toBe("/local/t1");
  });
});
