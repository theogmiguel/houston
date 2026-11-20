import { describe, expect, it, vi } from "vite-plus/test";

import { filePillDragHandlers } from "./filePillDrag";

function dragEvent() {
  const preventDefault = vi.fn();
  return { event: { preventDefault }, preventDefault };
}

describe("filePillDragHandlers", () => {
  it("starts a native drag with the path and workspace root", () => {
    const startFileDrag = vi.fn(async () => {});
    const { event, preventDefault } = dragEvent();
    const handlers = filePillDragHandlers(
      { path: "src/main.ts", workspaceRoot: "/work/atlas" },
      { bridge: { startFileDrag } },
    );

    expect(handlers?.draggable).toBe(true);
    handlers?.onDragStart(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(startFileDrag).toHaveBeenCalledWith({
      path: "src/main.ts",
      workspaceRoot: "/work/atlas",
    });
  });

  it("leaves the browser drag alone without a host bridge", () => {
    expect(
      filePillDragHandlers({ path: "src/main.ts", workspaceRoot: "/work/atlas" }),
    ).toBeUndefined();
  });

  it("needs both a path and a workspace root", () => {
    const bridge = { startFileDrag: vi.fn(async () => {}) };

    expect(filePillDragHandlers({ path: "", workspaceRoot: "/work/atlas" }, { bridge })).toBe(
      undefined,
    );
    expect(filePillDragHandlers({ path: "src/main.ts", workspaceRoot: " " }, { bridge })).toBe(
      undefined,
    );
  });

  it("reports a refused drag with the host's message", async () => {
    const startFileDrag = vi.fn(async () => {
      throw new Error('Cannot drag "../secret": it is outside the workspace root "/work/atlas".');
    });
    const reportError = vi.fn();
    const { event } = dragEvent();
    const handlers = filePillDragHandlers(
      { path: "../secret", workspaceRoot: "/work/atlas" },
      { bridge: { startFileDrag }, reportError },
    );

    handlers?.onDragStart(event);

    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        'Cannot drag "../secret": it is outside the workspace root "/work/atlas".',
      ),
    );
  });
});
