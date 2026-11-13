import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";
import { beginThreadDragAt, endThreadDrag } from "../../threads/threadDrag";
import { LayoutResizeGuide, LayoutResizeGutter } from "./layout-pane";
import { ThreadDragOverlay } from "./thread-drag-overlay";

const SOURCE = { threadId: "t1", environmentId: "env", projectId: "p1", title: "Fix the login" };
const ghost = () => document.querySelector<HTMLElement>("[data-thread-drag-ghost]");

describe("thread drag overlay", () => {
  it("carries the dragged card's title under the pointer until the drag ends", async () => {
    await using _screen = await render(<ThreadDragOverlay />, { router: false });
    expect(ghost()).toBeNull();
    await act(() => beginThreadDragAt(SOURCE, { x: 300, y: 200 }, 1));
    try {
      expect(ghost()!.textContent).toBe("Fix the login");
      const box = ghost()!.getBoundingClientRect();
      expect(box.left).toBeGreaterThan(300);
      expect(box.left).toBeLessThan(330);
    } finally {
      await act(() => endThreadDrag());
    }
    expect(ghost()).toBeNull();
  });
});

describe("resize guide", () => {
  it("is drawn in the gutter line's colour, so a drag shows one line", async () => {
    await using screen = await render(
      <div style={{ position: "relative", width: 200, height: 200 }}>
        <LayoutResizeGutter orientation="vertical" dragging style={{ left: 96, width: 8 }} />
        <LayoutResizeGuide orientation="vertical" style={{ left: 100, top: 0, bottom: 0 }} />
      </div>,
      { router: false },
    );
    const gutter = screen.container.querySelector<HTMLElement>("[data-layout-gutter]")!;
    const guide = screen.container.querySelector<HTMLElement>("[data-layout-resize-guide]")!;
    expect(getComputedStyle(guide).backgroundColor).toBe(
      getComputedStyle(gutter, "::after").backgroundColor,
    );
  });
});
