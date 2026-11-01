import "~/index.css";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { GridRecord } from "../../grid/gridStore";
import { beginThreadDrag, endThreadDrag } from "../../grid/threadDrag";
import { type LayoutNode, preorderLeaves, threadLeaf } from "../../grid/tree";
import { act, render } from "../../../test/render";
import { GridHost, type GridCellRenderProps } from "./GridHost";

function grid(tree: LayoutNode): GridRecord {
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
      data-testid={`cell-${cell.node.threadId}`}
      data-dragging={cell.dragging ? "true" : "false"}
      {...cell.dropTargetProps}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <div data-testid={`label-${cell.node.threadId}`} {...cell.dragHandleProps}>
        {cell.node.threadId}
      </div>
      {cell.dropIndicator === null ? null : (
        <div data-testid={`indicator-${cell.node.threadId}`} data-side={cell.dropIndicator} />
      )}
    </div>
  );
}

async function mount(
  tree: LayoutNode,
  options?: {
    onTreeChange?: (tree: LayoutNode | null) => void;
    onDropThread?: (
      source: { gridId: string; threadId: string },
      targetThreadId: string,
      side: string,
    ) => void;
  },
) {
  return render(
    <div style={{ display: "flex", width: 900, height: 600 }}>
      <GridHost
        grid={grid(tree)}
        onTreeChange={options?.onTreeChange ?? (() => {})}
        onFocusThread={() => {}}
        {...(options?.onDropThread === undefined ? {} : { onDropThread: options.onDropThread })}
        renderThread={cellMarkup}
      />
    </div>,
    { router: false },
  );
}

function element(container: HTMLElement, testId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`missing ${testId}`);
  return found;
}

function startDrag(label: HTMLElement, dataTransfer: DataTransfer): void {
  label.dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
    }),
  );
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

function dragOver(target: HTMLElement, dataTransfer: DataTransfer, point: Point): boolean {
  return target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
      ...coordinates(target, point),
    }),
  );
}

function drop(target: HTMLElement, dataTransfer: DataTransfer, point: Point): void {
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer,
      ...coordinates(target, point),
    }),
  );
}

afterEach(() => {
  endThreadDrag();
});

describe("GridHost drag and drop", () => {
  it("swaps two cells when a label is dropped on another cell's centre", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const dataTransfer = new DataTransfer();

    await act(() => startDrag(element(screen.container, "label-thread-a"), dataTransfer));
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("true");

    const target = element(screen.container, "cell-thread-b");
    await act(() => {
      expect(dragOver(target, dataTransfer, "center")).toBe(false);
    });
    expect(element(screen.container, "indicator-thread-b").dataset.side).toBe("center");

    await act(() => drop(target, dataTransfer, "center"));

    expect(onTreeChange).toHaveBeenCalledTimes(1);
    expect(preorderLeaves(onTreeChange.mock.calls[0]?.[0] as LayoutNode)).toEqual([
      "thread-b",
      "thread-a",
    ]);
    expect(element(screen.container, "cell-thread-a").dataset.dragging).toBe("false");
  });

  it("splits toward the edge under the pointer", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b", "thread-c"), { onTreeChange });
    const dataTransfer = new DataTransfer();

    await act(() => startDrag(element(screen.container, "label-thread-a"), dataTransfer));
    const target = element(screen.container, "cell-thread-c");
    await act(() => dragOver(target, dataTransfer, "left"));
    expect(element(screen.container, "indicator-thread-c").dataset.side).toBe("left");

    await act(() => drop(target, dataTransfer, "left"));

    expect(preorderLeaves(onTreeChange.mock.calls[0]?.[0] as LayoutNode)).toEqual([
      "thread-b",
      "thread-a",
      "thread-c",
    ]);
  });

  it("refuses an edge drop that would add a seventh cell but still allows a centre replace", async () => {
    const onDropThread = vi.fn();
    await using screen = await mount(row("t1", "t2", "t3", "t4", "t5", "t6"), { onDropThread });
    const dataTransfer = new DataTransfer();

    await act(() => beginThreadDrag({ gridId: "g-other", threadId: "thread-x" }));
    const target = element(screen.container, "cell-t1");
    await act(() => {
      expect(dragOver(target, dataTransfer, "right")).toBe(true);
    });
    expect(screen.container.querySelector('[data-testid="indicator-t1"]')).toBeNull();
    await act(() => drop(target, dataTransfer, "right"));
    expect(onDropThread).not.toHaveBeenCalled();

    await act(() => beginThreadDrag({ gridId: "g-other", threadId: "thread-x" }));
    await act(() => {
      expect(dragOver(target, dataTransfer, "center")).toBe(false);
    });
    expect(element(screen.container, "indicator-t1").dataset.side).toBe("center");
    await act(() => drop(target, dataTransfer, "center"));
    expect(onDropThread).toHaveBeenCalledWith(
      { gridId: "g-other", threadId: "thread-x" },
      "t1",
      "center",
    );
  });

  it("cancels the drag on Escape so the drop does nothing", async () => {
    const onTreeChange = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange });
    const dataTransfer = new DataTransfer();

    await act(() => startDrag(element(screen.container, "label-thread-a"), dataTransfer));
    const target = element(screen.container, "cell-thread-b");
    await act(() => dragOver(target, dataTransfer, "center"));
    expect(element(screen.container, "indicator-thread-b").dataset.side).toBe("center");

    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(screen.container.querySelector('[data-testid="indicator-thread-b"]')).toBeNull();
    await act(() => drop(target, dataTransfer, "center"));
    expect(onTreeChange).not.toHaveBeenCalled();
  });
});
