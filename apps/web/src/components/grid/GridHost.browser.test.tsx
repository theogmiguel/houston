import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";

import type { GridRecord } from "../../grid/gridStore";
import { beginThreadDragAt, endThreadDrag, type ThreadDragSource } from "../../threads/threadDrag";
import {
  type LayoutNode,
  preorderLeaves,
  preorderThreads,
  threadLeaf,
} from "@houston-app/shared/grid/tree";
import { act, render } from "../../../test/render";
import { configureMotion } from "../../motion/registry";
import { userEvent } from "vite-plus/test/browser";
import { ThreadDragOverlay } from "../ui/thread-drag-overlay";
import { GridHost, type GridCellRenderProps } from "./GridHost";

function grid(tree: LayoutNode, overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree,
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function row(...threadIds: string[]): LayoutNode {
  return {
    kind: "split",
    dir: "row",
    children: threadIds.map((threadId) => threadLeaf(threadId, `p-${threadId}`)),
    weights: threadIds.map(() => 100 / threadIds.length),
  };
}

function cellMarkup(cell: GridCellRenderProps) {
  return (
    <div
      data-grid-cell=""
      data-thread-id={cell.node.threadId}
      data-testid={`cell-${cell.node.threadId}`}
      data-dragging={cell.dragging ? "true" : "false"}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <div data-testid={`label-${cell.node.threadId}`} onPointerDown={cell.onDragHandlePointerDown}>
        {cell.node.threadId}
      </div>
      {cell.dropRefusal !== null ? (
        <div
          data-testid={`indicator-${cell.node.threadId}`}
          data-side="refusal"
          data-refusal={cell.dropRefusal}
        />
      ) : cell.dropIndicator === null ? null : (
        <div data-testid={`indicator-${cell.node.threadId}`} data-side={cell.dropIndicator} />
      )}
    </div>
  );
}

async function mount(
  tree: LayoutNode,
  options?: {
    grid?: Partial<GridRecord>;
    maximizedThreadId?: string;
    onTreeChange?: (tree: LayoutNode | null) => void;
    onDropThread?: (source: ThreadDragSource, targetThreadId: string, side: string) => void;
  },
) {
  return render(
    <div style={{ display: "flex", width: 900, height: 600 }}>
      <GridHost
        grid={grid(tree, options?.grid)}
        {...(options?.maximizedThreadId === undefined
          ? {}
          : { maximizedThreadId: options.maximizedThreadId })}
        onTreeChange={options?.onTreeChange ?? (() => {})}
        onFocusThread={() => {}}
        {...(options?.onDropThread === undefined ? {} : { onDropThread: options.onDropThread })}
        renderThread={cellMarkup}
      />
      <ThreadDragOverlay />
    </div>,
    { router: false },
  );
}

function element(container: HTMLElement, testId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing ${testId}`);
  return found;
}

type Point = "center" | "left" | "right" | "top" | "bottom";

function coordinates(target: HTMLElement, point: Point): { clientX: number; clientY: number } {
  const rect = target.getBoundingClientRect();
  const middleX = rect.left + rect.width / 2;
  const middleY = rect.top + rect.height / 2;
  switch (point) {
    case "left":
      return { clientX: rect.left + rect.width * 0.1, clientY: middleY };
    case "right":
      return { clientX: rect.left + rect.width * 0.9, clientY: middleY };
    case "top":
      return { clientX: middleX, clientY: rect.top + rect.height * 0.1 };
    case "bottom":
      return { clientX: middleX, clientY: rect.top + rect.height * 0.9 };
    default:
      return { clientX: middleX, clientY: middleY };
  }
}

const POINTER_ID = 7;

function dragPoint(target: HTMLElement, at: Point): { x: number; y: number } {
  const point = coordinates(target, at);
  return { x: point.clientX, y: point.clientY };
}

function press(
  element: HTMLElement,
  point: { clientX: number; clientY: number },
  button = 0,
): void {
  element.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      button,
      clientX: point.clientX,
      clientY: point.clientY,
    }),
  );
}

function pointerMove(
  point: { clientX: number; clientY: number },
  target: EventTarget = window,
): void {
  target.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      clientX: point.clientX,
      clientY: point.clientY,
    }),
  );
}

function release(point: { clientX: number; clientY: number }): void {
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      clientX: point.clientX,
      clientY: point.clientY,
    }),
  );
}

const OTHER_PROJECT: ThreadDragSource = {
  gridId: "g-other",
  threadId: "thread-x",
  environmentId: "env-1",
  projectId: "project-2",
};

const OTHER_GRID: ThreadDragSource = {
  gridId: "g-other",
  threadId: "thread-x",
  environmentId: "env-1",
  projectId: "project-1",
};

async function expectAnnouncement(text: string): Promise<void> {
  await vi.waitFor(() => {
    const spoken = Array.from(document.querySelectorAll('[aria-live="polite"]'))
      .map((region) => region.textContent)
      .join(" ");
    expect(spoken).toContain(text);
  });
}

function threadDragGuard() {
  return { [Symbol.dispose]: () => endThreadDrag() };
}

describe("GridHost drag and drop", () => {
  it("swaps two cells when a label is dropped on another cell's centre", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("true");

    await act(() => pointerMove(end));
    expect(element(screen.container, "indicator-thread-b").dataset.side).toBe("center");

    await act(() => release(end));

    expect(onTreeChange).toHaveBeenCalledTimes(1);
    expect(preorderLeaves(onTreeChange.mock.calls[0]?.[0] as LayoutNode)).toEqual([
      "thread-b",
      "thread-a",
    ]);
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("false");
    expect(document.querySelector("[data-thread-drag-overlay]")).toBeNull();
    await expectAnnouncement("Swapped");
  });

  it("splits toward the edge under the pointer", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b", "thread-c"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-c");
    const start = coordinates(label, "center");
    const end = coordinates(target, "left");

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    expect(element(screen.container, "indicator-thread-c").dataset.side).toBe("left");

    await act(() => release(end));

    expect(preorderLeaves(onTreeChange.mock.calls[0]?.[0] as LayoutNode)).toEqual([
      "thread-b",
      "thread-a",
      "thread-c",
    ]);
    await expectAnnouncement("Docked the dragged thread");
  });

  it("ignores a drop on the cell being dragged", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    const onDropThread = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange, onDropThread });
    const label = element(screen.container, "label-thread-a");
    const self = element(screen.container, "cell-thread-a");
    const start = coordinates(label, "center");
    const end = coordinates(self, "center");

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    expect(screen.container.querySelector('[data-testid="indicator-thread-a"]')).toBeNull();
    await act(() => release(end));

    expect(onTreeChange).not.toHaveBeenCalled();
    expect(onDropThread).not.toHaveBeenCalled();
  });

  it("shows a full-grid refusal on an edge and still lets the drop explain it", async () => {
    using _drag = threadDragGuard();
    const onDropThread = vi.fn();
    await using screen = await mount(row("t1", "t2", "t3", "t4", "t5", "t6"), { onDropThread });
    const target = element(screen.container, "cell-t1");

    await act(() => beginThreadDragAt(OTHER_GRID, dragPoint(target, "right"), POINTER_ID));
    expect(element(screen.container, "indicator-t1").dataset.refusal).toBe("grid-full");
    await act(() => release(coordinates(target, "right")));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_GRID, "t1", "right");
    endThreadDrag();

    await act(() => beginThreadDragAt(OTHER_GRID, dragPoint(target, "center"), POINTER_ID));
    expect(element(screen.container, "indicator-t1").dataset.side).toBe("center");
    await act(() => release(coordinates(target, "center")));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_GRID, "t1", "center");
  });

  it("refuses a thread from another project during hover", async () => {
    using _drag = threadDragGuard();
    const onDropThread = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onDropThread });
    const target = element(screen.container, "cell-thread-b");

    await act(() => beginThreadDragAt(OTHER_PROJECT, dragPoint(target, "center"), POINTER_ID));
    expect(element(screen.container, "indicator-thread-b").dataset.refusal).toBe(
      "different-project",
    );

    await act(() => release(coordinates(target, "center")));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_PROJECT, "thread-b", "center");
    await expectAnnouncement("Different project");
  });

  it("cancels the drag on Escape so the drop does nothing", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    expect(element(screen.container, "indicator-thread-b").dataset.side).toBe("center");

    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(screen.container.querySelector('[data-testid="indicator-thread-b"]')).toBeNull();
    await act(() => release(end));
    expect(onTreeChange).not.toHaveBeenCalled();
  });
});

describe("GridHost pointer drag conditions", () => {
  it("keeps a press without movement a click", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const point = coordinates(label, "center");
    const click = vi.fn();
    label.addEventListener("click", click);

    await act(() => press(label, point));
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("false");
    await act(() => release(point));

    expect(onTreeChange).not.toHaveBeenCalled();
    await act(() =>
      label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
    );
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("does not start a drag under the six pixel threshold", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const point = coordinates(label, "center");

    await act(() => press(label, point));
    await act(() => pointerMove({ clientX: point.clientX + 4, clientY: point.clientY }));
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("false");
    await act(() => release({ clientX: point.clientX + 4, clientY: point.clientY }));

    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("never starts a drag from the right or middle button", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");

    for (const button of [1, 2]) {
      await act(() => press(label, start, button));
      await act(() => pointerMove(end));
      await act(() => release(end));
    }

    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("false");
    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("cancels on pointercancel and on window blur", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: POINTER_ID }));
    });
    expect(screen.container.querySelector('[data-testid="indicator-thread-b"]')).toBeNull();
    await act(() => release(end));

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    await act(() => window.dispatchEvent(new Event("blur")));
    expect(screen.container.querySelector('[data-testid="indicator-thread-b"]')).toBeNull();
    await act(() => release(end));

    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("changes nothing when the drop lands outside every cell", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const start = coordinates(label, "center");
    const outside = { clientX: -50, clientY: -50 };

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(outside));
    await act(() => release(outside));

    expect(onTreeChange).not.toHaveBeenCalled();
  });

  it("resolves a drop under the pointer even over a surface inside a cell", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");
    const surface = document.createElement("div");
    surface.style.cssText = "position:absolute;inset:0;pointer-events:auto";
    target.appendChild(surface);

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    const overlay = document.querySelector<HTMLElement>("[data-thread-drag-overlay]");
    if (overlay === null) throw new Error("drag overlay missing");
    expect(getComputedStyle(overlay).cursor).toBe("grabbing");
    expect(getComputedStyle(overlay).userSelect).toBe("none");

    await act(() => pointerMove(end, overlay));
    expect(element(screen.container, "indicator-thread-b").dataset.side).toBe("center");
    await act(() => release(end));

    expect(onTreeChange).toHaveBeenCalledTimes(1);
  });

  it("swallows the click that ends a drop", async () => {
    using _drag = threadDragGuard();
    await using screen = await mount(row("thread-a", "thread-b"));
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");
    const click = vi.fn();
    label.addEventListener("click", click);

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    await act(() => pointerMove(end));
    // The browser dispatches the click that ends a drag in the same task as the release.
    await act(() => {
      release(end);
      label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(click).not.toHaveBeenCalled();
  });

  it("clears any text selection when the drag starts", async () => {
    using _drag = threadDragGuard();
    await using screen = await mount(row("thread-a", "thread-b"));
    const label = element(screen.container, "label-thread-a");
    const target = element(screen.container, "cell-thread-b");
    const start = coordinates(label, "center");
    const end = coordinates(target, "center");
    const text = element(screen.container, "cell-thread-a").firstChild;
    if (text === null) throw new Error("cell text missing");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString().length).toBeGreaterThan(0);

    await act(() => press(label, start));
    await act(() => pointerMove({ clientX: start.clientX + 20, clientY: start.clientY }));
    expect(selection?.toString()).toBe("");

    await act(() => pointerMove(end));
    expect(selection?.toString()).toBe("");
    await act(() => release(end));
    expect(selection?.toString()).toBe("");
  });

  it("does not start a drag from a single cell or a maximized cell", async () => {
    using _drag = threadDragGuard();
    await using single = await mount(threadLeaf("thread-a", "p-thread-a"));
    const singleLabel = element(single.container, "label-thread-a");
    const singlePoint = coordinates(singleLabel, "center");
    await act(() => press(singleLabel, singlePoint));
    await act(() =>
      pointerMove({ clientX: singlePoint.clientX + 20, clientY: singlePoint.clientY }),
    );
    expect(element(single.container, "cell-thread-a").dataset.dragging).toBe("false");
    await act(() => release({ clientX: singlePoint.clientX + 20, clientY: singlePoint.clientY }));

    await using maximized = await mount(row("thread-a", "thread-b"), {
      maximizedThreadId: "thread-a",
    });
    const maximizedLabel = element(maximized.container, "label-thread-a");
    const maximizedPoint = coordinates(maximizedLabel, "center");
    await act(() => press(maximizedLabel, maximizedPoint));
    await act(() =>
      pointerMove({ clientX: maximizedPoint.clientX + 20, clientY: maximizedPoint.clientY }),
    );
    expect(element(maximized.container, "cell-thread-a").dataset.dragging).toBe("false");
  });
});

function flipMarkup(cell: GridCellRenderProps) {
  return (
    <div
      data-grid-cell=""
      data-thread-id={cell.node.threadId}
      data-testid={`flip-${cell.node.threadId}`}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    >
      {cell.node.threadId}
    </div>
  );
}

async function mountFlip(tree: LayoutNode) {
  const element = (node: LayoutNode) => (
    <div style={{ display: "flex", width: 900, height: 600 }}>
      <GridHost
        grid={grid(node)}
        onTreeChange={() => {}}
        onFocusThread={() => {}}
        renderThread={flipMarkup}
      />
    </div>
  );
  const screen = await render(element(tree), { router: false });
  return { screen, show: (node: LayoutNode) => screen.rerender(element(node)) };
}

describe("GridHost cell motion", () => {
  it("moves a swapped cell with a transform animation", async () => {
    const { screen, show } = await mountFlip(row("thread-a", "thread-b"));
    const a = screen.container.querySelector<HTMLElement>('[data-thread-id="thread-a"]')!;
    await show(row("thread-b", "thread-a"));
    expect(a.getAnimations().length).toBe(1);
    expect(a.style.transform).toBe("");
  });

  it("retargets a cell already moving at its new target", async () => {
    const { screen, show } = await mountFlip(row("thread-a", "thread-b", "thread-c"));
    const a = screen.container.querySelector<HTMLElement>('[data-thread-id="thread-a"]')!;
    await show(row("thread-b", "thread-a", "thread-c"));
    await show(row("thread-b", "thread-c", "thread-a"));
    expect(a.getAnimations().length).toBe(1);
  });

  it("settles instantly under reduced motion", async () => {
    configureMotion({ off: true });
    try {
      const { screen, show } = await mountFlip(row("thread-a", "thread-b"));
      const a = screen.container.querySelector<HTMLElement>('[data-thread-id="thread-a"]')!;
      await show(row("thread-b", "thread-a"));
      expect(a.getAnimations().length).toBe(0);
    } finally {
      configureMotion({ off: false });
    }
  });
});

describe("GridHost resize", () => {
  async function mountRow(onTreeChange: (tree: LayoutNode | null) => void) {
    return mount(row("thread-a", "thread-b"), { onTreeChange });
  }

  it("draws one divider for a two-cell grid and none for one cell", async () => {
    await using screen = await mountRow(() => {});
    const gutter = screen.container.querySelector<HTMLElement>("[data-grid-gutter]")!;
    expect(gutter.getBoundingClientRect().width).toBe(8);
    expect(gutter.getAttribute("role")).toBe("separator");
    expect(gutter.tabIndex).toBe(0);

    await using single = await mount(threadLeaf("thread-a", "p-thread-a"));
    expect(single.container.querySelector("[data-grid-gutter]")).toBeNull();
  });

  it("hides the divider while a cell is maximized", async () => {
    await using screen = await mount(row("thread-a", "thread-b"), {
      maximizedThreadId: "thread-a",
    });
    expect(screen.container.querySelector("[data-grid-gutter]")).toBeNull();
  });

  it("previews on the pointer, snaps at a preset, and persists once on release", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mountRow(onTreeChange);
    const gutter = screen.container.querySelector<HTMLElement>("[data-grid-gutter]")!;
    const rect = gutter.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const startX = rect.left + rect.width / 2;
    using _capture = vi.spyOn(gutter, "setPointerCapture").mockImplementation(() => {});
    const pointer = { bubbles: true, pointerId: 1, button: 0 };

    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, clientX: startX, clientY: y }),
      );
    });
    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientX: startX - 150, clientY: y }),
      );
    });
    const badge = gutter.querySelector<HTMLElement>("[data-grid-resize-badge]")!;
    await vi.waitFor(() => expect(badge.textContent).toBe("⅓ width"));

    // Live preview only writes the slot widths; the store stays untouched.
    expect(onTreeChange).not.toHaveBeenCalled();
    expect(badge.style.display).toBe("inline-block");

    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointerup", { ...pointer, clientX: startX - 150, clientY: y }),
      );
    });

    expect(onTreeChange).toHaveBeenCalledTimes(1);
    const next = onTreeChange.mock.calls[0]?.[0] as LayoutNode;
    expect(next.kind).toBe("split");
    if (next.kind === "split") expect(next.weights[0]).toBeCloseTo(100 / 3, 2);
    expect(badge.style.display).toBe("inline-block");
  });

  it("keeps both cells visible after clicking the divider without moving", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mountRow(onTreeChange);
    const gutter = screen.container.querySelector<HTMLElement>("[data-grid-gutter]")!;
    const rect = gutter.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    using _capture = vi.spyOn(gutter, "setPointerCapture").mockImplementation(() => {});
    const pointer = { bubbles: true, pointerId: 1, button: 0, ...at };

    for (let click = 0; click < 2; click += 1) {
      await act(() => gutter.dispatchEvent(new PointerEvent("pointerdown", pointer)));
      await act(() => gutter.dispatchEvent(new PointerEvent("pointerup", pointer)));
    }

    expect(onTreeChange).not.toHaveBeenCalled();
    const slots = screen.container.querySelectorAll<HTMLElement>("[data-grid-slot]");
    expect(slots).toHaveLength(2);
    for (const slot of slots) expect(slot.getBoundingClientRect().width).toBeGreaterThan(100);
  });

  it("never collapses a cell below the fraction floor", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mountRow(onTreeChange);
    const gutter = screen.container.querySelector<HTMLElement>("[data-grid-gutter]")!;
    const rect = gutter.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const startX = rect.left + rect.width / 2;
    using _capture = vi.spyOn(gutter, "setPointerCapture").mockImplementation(() => {});
    const pointer = { bubbles: true, pointerId: 1, button: 0 };

    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, clientX: startX, clientY: y }),
      );
    });
    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointermove", { ...pointer, clientX: -2000, clientY: y }),
      );
    });
    await vi.waitFor(() =>
      expect(gutter.querySelector<HTMLElement>("[data-grid-resize-badge]")!.style.display).toBe(
        "inline-block",
      ),
    );
    await act(() => {
      gutter.dispatchEvent(
        new PointerEvent("pointerup", { ...pointer, clientX: -2000, clientY: y }),
      );
    });

    const next = onTreeChange.mock.calls[0]?.[0] as LayoutNode;
    if (next.kind !== "split") throw new Error("expected a split");
    expect(next.weights[0]).toBeGreaterThanOrEqual(20);
    expect(next.weights[1]).toBeGreaterThanOrEqual(20);
  });

  it("evens the split on double-click and steps presets from the keyboard", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mount(
      {
        kind: "split",
        dir: "row",
        children: [threadLeaf("thread-a", "p-a"), threadLeaf("thread-b", "p-b")],
        weights: [30, 70],
      },
      { onTreeChange },
    );
    const gutter = screen.container.querySelector<HTMLElement>("[data-grid-gutter]")!;
    using _capture = vi.spyOn(gutter, "setPointerCapture").mockImplementation(() => {});

    await act(() => {
      gutter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onTreeChange).toHaveBeenCalledTimes(1);
    const evened = onTreeChange.mock.calls[0]?.[0] as LayoutNode;
    if (evened.kind !== "split") throw new Error("expected a split");
    expect(evened.weights[0]).toBeCloseTo(50, 5);

    gutter.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onTreeChange).toHaveBeenCalledTimes(2);
    const stepped = onTreeChange.mock.calls[1]?.[0] as LayoutNode;
    if (stepped.kind !== "split") throw new Error("expected a split");
    expect(stepped.weights[0]).toBeCloseTo((1 / 3) * 100, 5);
  });
});

describe("GridHost surface", () => {
  it("lays two or more cells out as cards with an 8px gutter and one cell edge to edge", async () => {
    await using screen = await mount(row("thread-a", "thread-b"));
    const surface = screen.container.querySelector<HTMLElement>("[data-grid-surface]")!;
    expect(surface.hasAttribute("data-multi")).toBe(true);

    await using single = await mount(threadLeaf("thread-a", "p-thread-a"));
    const soloSurface = single.container.querySelector<HTMLElement>("[data-grid-surface]")!;
    expect(soloSurface.hasAttribute("data-multi")).toBe(false);
    expect(getComputedStyle(soloSurface).paddingLeft).toBe("0px");
  });

  it("tells only the maximized cell it shows alone, so the hidden cells do not re-render", async () => {
    const maximized = new Map<string, boolean>();
    await using _screen = await render(
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(row("thread-a", "thread-b", "thread-c"))}
          maximizedThreadId="thread-b"
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          renderThread={(cell) => {
            maximized.set(cell.node.threadId, cell.maximized);
            return cellMarkup(cell);
          }}
        />
      </div>,
      { router: false },
    );
    expect(Object.fromEntries(maximized)).toEqual({
      "thread-a": false,
      "thread-b": true,
      "thread-c": false,
    });
  });

  it("keeps every cell on one compositing layer alone, in a grid and maximized", async () => {
    const layers = (container: HTMLElement) =>
      [...container.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => [
        getComputedStyle(cell).willChange,
        getComputedStyle(cell, "::before").willChange,
      ]);
    await using solo = await mount(threadLeaf("thread-a", "p-thread-a"));
    await using multi = await mount(row("thread-a", "thread-b"));
    await using maximized = await mount(row("thread-a", "thread-b"), {
      maximizedThreadId: "thread-a",
    });
    for (const screen of [solo, multi, maximized]) {
      for (const layer of layers(screen.container)) {
        expect(layer).toEqual(["transform", "opacity"]);
      }
    }
  });

  it("times going solo and back on the motion roles, so reduced motion stops it", async () => {
    await using screen = await mount(row("thread-a", "thread-b"));
    const cell = screen.container.querySelector<HTMLElement>(
      '[data-grid-cell][data-thread-id="thread-a"]',
    )!;
    const label = document.createElement("div");
    label.dataset.paneLabel = "";
    cell.append(label);
    for (const style of [getComputedStyle(cell, "::before"), getComputedStyle(label)]) {
      expect(style.transitionDuration.split(", ")).toEqual(["0.16s", "0.16s"]);
    }
    configureMotion({ off: true });
    try {
      expect(getComputedStyle(cell, "::before").transitionDuration).toBe("0s, 0s");
    } finally {
      configureMotion({ off: false });
    }
  });

  it("fades a closing cell out over its last box while the survivor takes its room", async () => {
    const changes: Array<LayoutNode | null> = [];
    let close: (() => void) | null = null;
    await using screen = await render(
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(row("thread-a", "thread-b"))}
          onTreeChange={(tree) => changes.push(tree)}
          onFocusThread={() => {}}
          renderThread={(cell) => {
            if (cell.node.threadId === "thread-b") close = cell.onClose;
            return cellMarkup(cell);
          }}
        />
      </div>,
      { router: false },
    );

    const surface = screen.container.querySelector<HTMLElement>("[data-grid-surface]")!;
    const leaving = screen.container.querySelector<HTMLElement>(
      '[data-grid-cell-frame="thread-b"]',
    )!;
    const before = leaving.getBoundingClientRect().toJSON();
    await act(() => close?.());
    // The survivor already reads as one thread, at its final size, while the closing cell fades.
    expect(screen.container.querySelector("[data-grid-surface][data-multi]")).toBeNull();
    expect(screen.container.querySelector('[data-cell-place="thread-b"]')).toBeNull();
    const survivor = screen.container.querySelector<HTMLElement>('[data-cell-place="thread-a"]')!;
    expect(survivor.getBoundingClientRect().width).toBe(surface.clientWidth);
    expect(leaving.hasAttribute("data-leaving")).toBe(true);
    expect(getComputedStyle(leaving).visibility).toBe("visible");
    expect(leaving.getBoundingClientRect().toJSON()).toEqual(before);
    expect(getComputedStyle(leaving).transitionProperty).toBe("opacity");
    expect(changes).toEqual([]);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(preorderThreads(changes[0] ?? null).map((leaf) => leaf.threadId)).toEqual(["thread-a"]);
  });

  async function mountAsyncClose() {
    let close: (() => void) | null = null;
    const requests: Array<{ threadId: string; settle: () => void }> = [];
    const view = (tree: LayoutNode) => (
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(tree)}
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          onCloseThread={(threadId) =>
            new Promise<void>((resolve) => requests.push({ threadId, settle: resolve }))
          }
          renderThread={(cell) => {
            if (cell.node.threadId === "thread-b") close = cell.onClose;
            return cellMarkup(cell);
          }}
        />
      </div>
    );
    const screen = await render(view(row("thread-a", "thread-b")), { router: false });
    return {
      screen,
      requests,
      close: () => close?.(),
      show: (tree: LayoutNode) => screen.rerender(view(tree)),
    };
  }

  it("keeps a closing cell gone while the server settles its thread", async () => {
    const stage = await mountAsyncClose();
    await using _screen = stage.screen;
    await act(() => stage.close());
    await vi.waitFor(() => expect(stage.requests).toHaveLength(1));
    // The close request is in flight and the thread is still in the tree: nothing snaps back.
    await act(async () => {});
    const container = stage.screen.container;
    expect(
      container.querySelector('[data-grid-cell-frame="thread-b"][data-leaving]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-grid-surface][data-multi]")).toBeNull();

    await stage.show(threadLeaf("thread-a", "p-thread-a"));
    await act(() => stage.requests[0]?.settle());
    expect(container.querySelector("[data-leaving]")).toBeNull();
    expect(container.querySelector('[data-grid-cell-frame="thread-b"]')).toBeNull();
  });

  it("brings a closing cell back when the server keeps its thread", async () => {
    const stage = await mountAsyncClose();
    await using _screen = stage.screen;
    await act(() => stage.close());
    await vi.waitFor(() => expect(stage.requests).toHaveLength(1));
    await act(() => stage.requests[0]?.settle());
    const container = stage.screen.container;
    await vi.waitFor(() => expect(container.querySelector("[data-leaving]")).toBeNull());
    expect(container.querySelector("[data-grid-surface][data-multi]")).not.toBeNull();
  });

  it("lays a joining cell out at its final size and fades it in", async () => {
    const view = (tree: LayoutNode) => (
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(tree)}
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          renderThread={cellMarkup}
        />
      </div>
    );
    await using screen = await render(view(row("thread-a", "thread-b")), { router: false });
    await screen.rerender(view(row("thread-a", "thread-b", "thread-c")));
    const surface = screen.container.querySelector<HTMLElement>("[data-grid-surface]")!;
    const third = (surface.clientWidth - 2 * 8 - 2 * 8) / 3;
    for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
      const place = screen.container.querySelector<HTMLElement>(`[data-cell-place="${threadId}"]`)!;
      expect(place.getBoundingClientRect().width).toBeCloseTo(third, 0);
    }
    // Only the compositor moves: no slot eases its size, which would relayout every chat per frame.
    for (const slot of screen.container.querySelectorAll<HTMLElement>("[data-grid-slot]")) {
      expect(getComputedStyle(slot).transitionProperty).not.toMatch(/flex/);
    }
    const joining = screen.container.querySelector<HTMLElement>(
      '[data-grid-cell-frame="thread-c"]',
    )!;
    expect(joining.hasAttribute("data-entering")).toBe(true);
    expect(getComputedStyle(joining).transitionProperty).toBe("opacity");
  });
});

describe("GridHost stable cells", () => {
  async function mountStable(tree: LayoutNode, maximizedThreadId?: string) {
    const view = (node: LayoutNode, maximized?: string) => (
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(node)}
          {...(maximized === undefined ? {} : { maximizedThreadId: maximized })}
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          renderThread={cellMarkup}
        />
      </div>
    );
    const screen = await render(view(tree, maximizedThreadId), { router: false });
    const detached: string[] = [];
    // Moving a cell's DOM restyles and relayouts its whole subtree, which is what stalls a swap.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const cells = node.matches("[data-grid-cell]")
            ? [node]
            : [...node.querySelectorAll<HTMLElement>("[data-grid-cell]")];
          for (const cell of cells) detached.push(cell.dataset.threadId ?? "?");
        }
      }
    });
    observer.observe(screen.container, { childList: true, subtree: true });
    return {
      screen,
      detached,
      show: (node: LayoutNode, maximized?: string) => screen.rerender(view(node, maximized)),
      cell: (threadId: string) =>
        screen.container.querySelector<HTMLElement>(
          `[data-grid-cell][data-thread-id="${threadId}"]`,
        )!,
      [Symbol.asyncDispose]: async () => {
        observer.disconnect();
        await screen[Symbol.asyncDispose]();
      },
    };
  }

  function nested(): LayoutNode {
    return {
      kind: "split",
      dir: "row",
      children: [
        threadLeaf("thread-a", "p-thread-a"),
        {
          kind: "split",
          dir: "col",
          children: [threadLeaf("thread-b", "p-thread-b"), threadLeaf("thread-c", "p-thread-c")],
          weights: [50, 50],
        },
      ],
      weights: [50, 50],
    };
  }

  it("keeps every cell's DOM in place when two cells swap", async () => {
    await using stage = await mountStable(row("thread-a", "thread-b"));
    const a = stage.cell("thread-a");
    await stage.show(row("thread-b", "thread-a"));
    expect(stage.cell("thread-a")).toBe(a);
    expect(stage.detached).toEqual([]);
  });

  it("keeps every cell's DOM in place when a cell moves into another split", async () => {
    await using stage = await mountStable(nested());
    const a = stage.cell("thread-a");
    const c = stage.cell("thread-c");
    const tree = nested();
    if (tree.kind !== "split" || tree.children[1]?.kind !== "split") throw new Error("bad tree");
    const swapped: LayoutNode = {
      ...tree,
      children: [
        threadLeaf("thread-c", "p-thread-c"),
        {
          ...tree.children[1],
          children: [threadLeaf("thread-b", "p-thread-b"), threadLeaf("thread-a", "p-thread-a")],
        },
      ],
    };
    await stage.show(swapped);
    expect(stage.cell("thread-a")).toBe(a);
    expect(stage.cell("thread-c")).toBe(c);
    expect(stage.detached).toEqual([]);
  });

  it("keeps a cell's DOM in place when another thread takes its pane", async () => {
    await using stage = await mountStable(row("thread-a", "thread-b"));
    const a = stage.cell("thread-a");
    const tree = row("thread-a", "thread-b");
    if (tree.kind !== "split") throw new Error("bad tree");
    // A subagent opened in its parent's cell, then the parent back: one pane, two threads.
    await stage.show({
      ...tree,
      children: [threadLeaf("thread-sub", "p-thread-a"), tree.children[1]!],
    });
    expect(stage.cell("thread-sub")).toBe(a);
    expect(a.closest("[data-grid-cell-frame]")?.hasAttribute("data-entering")).toBe(false);
    await stage.show(row("thread-a", "thread-b"));
    expect(stage.cell("thread-a")).toBe(a);
    expect(stage.detached).toEqual([]);
  });

  it("keeps every cell's DOM in place when a cell is maximized and restored", async () => {
    await using stage = await mountStable(row("thread-a", "thread-b"));
    const a = stage.cell("thread-a");
    const b = stage.cell("thread-b");
    await stage.show(row("thread-a", "thread-b"), "thread-b");
    await stage.show(row("thread-a", "thread-b"));
    expect(stage.cell("thread-a")).toBe(a);
    expect(stage.cell("thread-b")).toBe(b);
    expect(stage.detached).toEqual([]);
  });

  it("places each cell exactly over its slot and a maximized cell over the whole surface", async () => {
    await using stage = await mountStable(nested());
    const surface = stage.screen.container.querySelector<HTMLElement>("[data-grid-surface]")!;
    for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
      const slot = stage.screen.container.querySelector<HTMLElement>(
        `[data-cell-place="${threadId}"]`,
      )!;
      expect(stage.cell(threadId).getBoundingClientRect().toJSON()).toEqual(
        slot.getBoundingClientRect().toJSON(),
      );
    }
    await stage.show(nested(), "thread-c");
    // The surface drops its card padding over a short transition; the cell follows it.
    await vi.waitFor(() => {
      const content = surface.getBoundingClientRect();
      const maximized = stage.cell("thread-c").getBoundingClientRect();
      expect([maximized.width, maximized.height]).toEqual([content.width, content.height]);
    });
    // The neighbours hide behind the maximized cell.
    await vi.waitFor(() => {
      expect(getComputedStyle(stage.cell("thread-a")).visibility).toBe("hidden");
    });
  });
});

describe("GridHost top bar surface", () => {
  it.each(["light", "dark"] as const)(
    "paints the top bar with the gutter colour and no divider in the %s theme",
    async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await using screen = await render(
        <div data-grid-page="" style={{ display: "flex", flexDirection: "column", height: 600 }}>
          <header
            data-drag-region="deep"
            className="border-b border-border"
            style={{ height: 40 }}
          />
          <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <GridHost
              grid={grid(row("thread-a", "thread-b"))}
              onTreeChange={() => {}}
              onFocusThread={() => {}}
              renderThread={cellMarkup}
            />
          </div>
        </div>,
        { router: false },
      );
      const header = screen.container.querySelector<HTMLElement>("header")!;
      const surface = screen.container.querySelector<HTMLElement>("[data-grid-surface]")!;
      expect(getComputedStyle(header).backgroundColor).toBe(
        getComputedStyle(surface).backgroundColor,
      );
      expect(getComputedStyle(header).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
      document.documentElement.classList.remove("dark");
    },
  );

  it("keeps the top bar transparent over the canvas for a single pane", async () => {
    await using screen = await render(
      <div data-grid-page="" style={{ display: "flex", flexDirection: "column", height: 600 }}>
        <header data-drag-region="deep" style={{ height: 40 }} />
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <GridHost
            grid={grid(row("thread-a"))}
            onTreeChange={() => {}}
            onFocusThread={() => {}}
            renderThread={cellMarkup}
          />
        </div>
      </div>,
      { router: false },
    );
    const header = screen.container.querySelector<HTMLElement>("header")!;
    expect(getComputedStyle(header).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });
});
