import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { GridRecord } from "../../grid/gridStore";
import { type LayoutNode, threadLeaf } from "../../grid/tree";
import { GridHost, type GridCellRenderProps } from "./GridHost";

function gridWith(tree: LayoutNode | null): GridRecord {
  return {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree,
    focusedThreadId: "thread-b",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const noop = () => {};

function render(tree: LayoutNode | null) {
  return renderToStaticMarkup(
    <GridHost
      grid={gridWith(tree)}
      onTreeChange={noop}
      onFocusThread={noop}
      renderThread={({ node, focused }) => (
        <div data-testid="cell" data-thread-id={node.threadId} data-focused={focused}>
          {node.threadId}
        </div>
      )}
    />,
  );
}

describe("GridHost", () => {
  it("renders one thread view per cell, in layout order, marking the focused cell", () => {
    const tree: LayoutNode = {
      kind: "split",
      dir: "row",
      children: [
        {
          kind: "split",
          dir: "col",
          children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-c", "p2")],
          weights: [50, 50],
        },
        threadLeaf("thread-b", "p3"),
      ],
      weights: [50, 50],
    };
    const html = render(tree);
    expect(html).toContain('data-thread-id="thread-a"');
    expect(html).toContain('data-thread-id="thread-b"');
    expect(html).toContain('data-thread-id="thread-c"');
    expect(html.indexOf("thread-a")).toBeLessThan(html.indexOf("thread-b"));
    expect(html).toContain('data-focused="true"');
    expect(html.match(/data-focused="false"/g)).toHaveLength(2);
    expect(html.match(/data-testid="cell"/g)).toHaveLength(3);
  });

  it("shows the empty state instead of mounting a thread view", () => {
    const html = render(null);
    expect(html).toContain("This grid is empty");
    expect(html).not.toContain('data-testid="cell"');
  });

  it("renders a resizer between neighbouring cells", () => {
    const tree: LayoutNode = {
      kind: "split",
      dir: "row",
      children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
      weights: [50, 50],
    };
    const html = render(tree);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
  });

  it("hands each cell its thread id and close/split callbacks", () => {
    const spy = vi.fn((_cell: GridCellRenderProps) => null);
    renderToStaticMarkup(
      <GridHost
        grid={gridWith(threadLeaf("thread-a", "p1"))}
        onTreeChange={noop}
        onFocusThread={noop}
        renderThread={spy}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const cell = spy.mock.calls[0]?.[0];
    expect(cell?.node.threadId).toBe("thread-a");
    expect(cell?.focused).toBe(false);
  });
});
