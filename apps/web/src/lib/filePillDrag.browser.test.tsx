import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";
import { filePillDragHandlers, type FilePillDragHandlers } from "./filePillDrag";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));

function Chip(props: { readonly handlers: FilePillDragHandlers }) {
  return (
    <button type="button" {...props.handlers}>
      src/main.ts
    </button>
  );
}

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, {
    pointerId: 7,
    pointerType: "mouse",
    button: 0,
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
}

describe("a file chip's drag", () => {
  it("still starts the native file drag when the pointer leaves the window", async () => {
    const startFileDrag = vi.fn(async () => {});
    using _bridge = stubGlobal("hostBridge", { startFileDrag });
    const handlers = filePillDragHandlers({
      path: "src/main.ts",
      workspaceRoot: "/work/atlas",
      threadRef,
    })!;
    await using screen = await render(<Chip handlers={handlers} />, { router: false });

    const chip = screen.container.querySelector("button")!;
    await act(() => chip.dispatchEvent(pointer("pointerdown", 40, 40)));
    await act(() => window.dispatchEvent(pointer("pointermove", 60, 60)));
    await act(() => window.dispatchEvent(pointer("pointermove", -20, 60)));

    expect(startFileDrag).toHaveBeenCalledWith({
      path: "src/main.ts",
      workspaceRoot: "/work/atlas",
    });
  });
});
