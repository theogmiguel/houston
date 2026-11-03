import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";

import type { GridRecord } from "../../grid/gridStore";
import { beginThreadDrag, endThreadDrag, type ThreadDragSource } from "../../grid/threadDrag";
import { type LayoutNode, preorderLeaves, preorderThreads, threadLeaf } from "../../grid/tree";
import { act, render } from "../../../test/render";
import { configureMotion } from "../../motion/registry";
import { userEvent } from "vite-plus/test/browser";
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
      data-testid={`cell-${cell.node.threadId}`}
      data-dragging={cell.dragging ? "true" : "false"}
      {...cell.dropTargetProps}
      style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <div data-testid={`label-${cell.node.threadId}`} {...cell.dragHandleProps}>
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
    onTreeChange?: (tree: LayoutNode | null) => void;
    onDropThread?: (source: ThreadDragSource, targetThreadId: string, side: string) => void;
  },
) {
  return render(
    <div style={{ display: "flex", width: 900, height: 600 }}>
      <GridHost
        grid={grid(tree, options?.grid)}
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
    await expectAnnouncement("Swapped");
  });

  it("splits toward the edge under the pointer", async () => {
    using _drag = threadDragGuard();
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
    await expectAnnouncement("Docked the dragged thread");
  });

  it("ignores a drop on the cell being dragged", async () => {
    using _drag = threadDragGuard();
    const onTreeChange = vi.fn();
    const onDropThread = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onTreeChange, onDropThread });
    const dataTransfer = new DataTransfer();

    await act(() => startDrag(element(screen.container, "label-thread-a"), dataTransfer));
    const self = element(screen.container, "cell-thread-a");
    await act(() => dragOver(self, dataTransfer, "center"));
    expect(screen.container.querySelector('[data-testid="indicator-thread-a"]')).toBeNull();
    await act(() => drop(self, dataTransfer, "center"));

    expect(onTreeChange).not.toHaveBeenCalled();
    expect(onDropThread).not.toHaveBeenCalled();
  });

  it("shows a full-grid refusal on an edge and still lets the drop explain it", async () => {
    using _drag = threadDragGuard();
    const onDropThread = vi.fn();
    await using screen = await mount(row("t1", "t2", "t3", "t4", "t5", "t6"), { onDropThread });
    const dataTransfer = new DataTransfer();

    await act(() => beginThreadDrag(OTHER_GRID));
    const target = element(screen.container, "cell-t1");
    await act(() => {
      expect(dragOver(target, dataTransfer, "right")).toBe(false);
    });
    expect(element(screen.container, "indicator-t1").dataset.refusal).toBe("grid-full");
    await act(() => drop(target, dataTransfer, "right"));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_GRID, "t1", "right");

    await act(() => beginThreadDrag(OTHER_GRID));
    await act(() => {
      expect(dragOver(target, dataTransfer, "center")).toBe(false);
    });
    expect(element(screen.container, "indicator-t1").dataset.side).toBe("center");
    await act(() => drop(target, dataTransfer, "center"));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_GRID, "t1", "center");
  });

  it("refuses a thread from another project during hover", async () => {
    using _drag = threadDragGuard();
    const onDropThread = vi.fn();
    await using screen = await mount(row("thread-a", "thread-b"), { onDropThread });
    const dataTransfer = new DataTransfer();

    await act(() => beginThreadDrag(OTHER_PROJECT));
    const target = element(screen.container, "cell-thread-b");
    await act(() => {
      expect(dragOver(target, dataTransfer, "center")).toBe(false);
    });
    expect(element(screen.container, "indicator-thread-b").dataset.refusal).toBe(
      "different-project",
    );

    await act(() => drop(target, dataTransfer, "center"));
    expect(onDropThread).toHaveBeenCalledWith(OTHER_PROJECT, "thread-b", "center");
    await expectAnnouncement("Different project");
  });

  it("cancels the drag on Escape so the drop does nothing", async () => {
    using _drag = threadDragGuard();
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

function flipMarkup(cell: GridCellRenderProps) {
  return (
    <div
      data-grid-cell=""
      data-thread-id={cell.node.threadId}
      data-testid={`flip-${cell.node.threadId}`}
      {...cell.dropTargetProps}
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
    await using screen = await render(
      <div style={{ display: "flex", width: 900, height: 600 }}>
        <GridHost
          grid={grid(row("thread-a", "thread-b"))}
          maximizedThreadId="thread-a"
          onTreeChange={() => {}}
          onFocusThread={() => {}}
          renderThread={cellMarkup}
        />
      </div>,
      { router: false },
    );
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

  it("shrinks a closing cell away before it leaves the tree", async () => {
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

    await act(() => close?.());
    // The survivor already reads as one thread while the closing cell shrinks.
    expect(screen.container.querySelector("[data-grid-slot][data-leaving]")).not.toBeNull();
    expect(screen.container.querySelector("[data-grid-surface][data-multi]")).toBeNull();
    expect(changes).toEqual([]);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(preorderThreads(changes[0] ?? null).map((leaf) => leaf.threadId)).toEqual(["thread-a"]);
  });
});
