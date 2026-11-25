import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../test/render";
import { dispatchCommandPalette, useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import { LayoutDropZones } from "../layout/DropZones";
import { cancelLayoutDrag } from "../layout/layoutDrag";
import { buildLayout } from "../layout/layoutFixtures";
import { findLayoutTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import type { LayoutTabLabel } from "../layout/PaneTabBar";
import { LayoutWorkspaceStrip } from "../layout/WorkspaceStrip";
import { buildThreadActionItems, type CommandPaletteGroup } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "./ui/command-dialog";

const label = (tab: { id: string }): LayoutTabLabel => ({ title: tab.id });
const environmentId = EnvironmentId.make("local");

const items = buildThreadActionItems({
  threads: [
    makeThreadFixture({
      id: ThreadId.make("t1"),
      environmentId,
      title: "Fix the build",
      updatedAt: "2026-03-01T00:00:00.000Z",
    }),
  ],
  projectByKey: new Map(),
  icon: null,
  runThread: async () => {},
});
const groups: CommandPaletteGroup[] = [{ value: "threads", label: "Threads", items }];

function Scene({ onExecute }: { onExecute: () => void }) {
  const layout = useLayoutStore((state) => state.layout);
  return (
    <>
      <div style={{ width: 1000, height: 600, position: "fixed", left: 0, top: 0 }}>
        <LayoutWorkspaceStrip
          layout={layout}
          narrow={false}
          tabLabel={label}
          renderTab={(tab) => <div data-body={tab.id} style={{ flex: 1 }} />}
        />
        <LayoutDropZones tabLabel={label} />
      </div>
      <CommandDialog open>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent items={groups} inputProps={{ placeholder: "Search" }}>
            <CommandPaletteResults
              groups={groups}
              isActionsOnly={false}
              keybindings={[]}
              onExecuteItem={onExecute}
            />
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

function openLayout(): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]], [["c"]]]]));
  dispatchCommandPalette({ _tag: "SetOpen", open: true });
  return {
    [Symbol.dispose]: () => {
      cancelLayoutDrag();
      dispatchCommandPalette({ _tag: "SetOpen", open: false });
      useLayoutStore.getState().reset();
    },
  };
}

const pointer = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    pointerId: 3,
    pointerType: "mouse",
    button: 0,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
const move = (x: number, y: number) =>
  act(() => window.dispatchEvent(pointer("pointermove", x, y)));
const release = (x: number, y: number) =>
  act(() => window.dispatchEvent(pointer("pointerup", x, y)));
const overlay = () => document.querySelector<HTMLElement>("[data-layout-drag-overlay]");
const threadTab = () =>
  findLayoutTab(
    useLayoutStore.getState().layout,
    (tab) =>
      tab.content.kind === "chat" &&
      tab.content.target.kind === "server" &&
      tab.content.target.threadRef.threadId === "t1",
  );

async function pressRow() {
  const row = document.querySelector<HTMLElement>("[role='option'], [data-slot='command-item']")!;
  const rect = row.getBoundingClientRect();
  const start = { x: rect.left + 20, y: rect.top + 10 };
  await act(() => row.dispatchEvent(pointer("pointerdown", start.x, start.y)));
  return { row, start };
}

describe("dragging a thread out of the command palette", () => {
  it("closes the palette past the threshold and opens the thread where it is dropped", async () => {
    using _layout = openLayout();
    await using screen = await render(<Scene onExecute={() => {}} />, { router: false });
    const target = screen.container.ownerDocument
      .querySelector<HTMLElement>("[data-layout-pane-id='w0c1p0']")!
      .getBoundingClientRect();
    const { start } = await pressRow();
    await move(start.x + 2, start.y);
    expect(useCommandPaletteStore.getState().open).toBe(true);
    const point = { x: target.right - 10, y: target.top + 48 + (target.height - 48) / 2 };
    await move(point.x, point.y);
    expect(useCommandPaletteStore.getState().open).toBe(false);
    expect(overlay()).not.toBeNull();
    await release(point.x, point.y);
    expect(threadTab()).not.toBeNull();
    expect(useLayoutStore.getState().layout.workspaces[0]!.columns).toHaveLength(3);
  });

  it("cancels on Escape without opening the thread", async () => {
    using _layout = openLayout();
    await using _screen = await render(<Scene onExecute={() => {}} />, { router: false });
    const { start } = await pressRow();
    await move(start.x + 300, start.y + 100);
    expect(overlay()).not.toBeNull();
    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(overlay()).toBeNull();
    await release(start.x + 300, start.y + 100);
    expect(threadTab()).toBeNull();
  });

  it("still runs the row on a plain click", async () => {
    using _layout = openLayout();
    let executed = 0;
    await using _screen = await render(<Scene onExecute={() => (executed += 1)} />, {
      router: false,
    });
    const { row, start } = await pressRow();
    await move(start.x + 2, start.y + 1);
    await release(start.x + 2, start.y + 1);
    await act(() => row.click());
    expect(executed).toBe(1);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
