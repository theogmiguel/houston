import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";
import { WindowResizeGrips } from "./WindowResizeGrips";

describe("WindowResizeGrips", () => {
  it("draws eight edges and corners on a Tauri host", async () => {
    using _tauri = stubGlobal("__TAURI__", { core: { invoke: vi.fn() } });

    await using screen = await render(<WindowResizeGrips />, { router: false });

    expect(screen.container.querySelectorAll('[data-testid^="resize-grip-"]')).toHaveLength(8);
  });

  it("starts the native resize drag for the edge that was pressed", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    using _tauri = stubGlobal("__TAURI__", { core: { invoke } });

    await using screen = await render(<WindowResizeGrips />, { router: false });
    const east = screen.getByTestId("resize-grip-east").element();

    await act(() => {
      east.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(invoke).toHaveBeenCalledWith("window_start_resize_dragging", {
      direction: "east",
    });
  });

  it("renders nothing outside a Tauri host", async () => {
    await using screen = await render(<WindowResizeGrips />, { router: false });
    expect(screen.container.innerHTML).toBe("");
  });
});
