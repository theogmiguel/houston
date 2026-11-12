import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { useComposerDraftStore } from "../../composerDraftStore";
import { beginRowActionSweep, sweepActionProps } from "../../threads/rowActionSweep";
import { beginThreadDragAt, endThreadDrag, useThreadDropZone } from "../../threads/threadDrag";
import { THREAD_CONTEXT_DROP_EVENT } from "../chat/threadContextDrag";
import { render } from "../../../test/render";
import { useRowFileDrop } from "./useRowFileDrop";

/** Ends any drag a test leaves running, so the next test can start one. */
const endDragAfter = () => ({ [Symbol.dispose]: () => endThreadDrag() });

const source = (title?: string) => ({
  gridId: null,
  threadId: "t1",
  environmentId: "env-1",
  projectId: "p1",
  ...(title === undefined ? {} : { title }),
});

const center = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

function firePointer(type: string, point: { x: number; y: number }) {
  window.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      button: 0,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

describe("dragging a thread onto a chat composer", () => {
  function Target({ onDrop }: { onDrop: (detail: unknown) => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    return (
      <div
        ref={(element) => {
          ref.current = element;
          element?.addEventListener(THREAD_CONTEXT_DROP_EVENT, (event) =>
            onDrop((event as CustomEvent).detail),
          );
        }}
        data-thread-context-drop="true"
        style={{ width: 200, height: 100 }}
      />
    );
  }

  it("marks the composer while a titled thread is over it and drops the thread's ref on release", async () => {
    using _drag = endDragAfter();
    const onDrop = vi.fn();
    await using screen = await render(<Target onDrop={onDrop} />, { router: false });
    const target = screen.container.querySelector<HTMLElement>("[data-thread-context-drop]")!;

    beginThreadDragAt(source("Fix the rail"), center(target), 7);
    expect(target.getAttribute("data-thread-context-over")).toBe("true");
    firePointer("pointerup", center(target));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith([{ environmentId: "env-1", threadId: "t1" }]);
    expect(target.hasAttribute("data-thread-context-over")).toBe(false);
  });

  it("does nothing for a source without a title, or when the drag is cancelled", async () => {
    using _drag = endDragAfter();
    const onDrop = vi.fn();
    await using screen = await render(<Target onDrop={onDrop} />, { router: false });
    const target = screen.container.querySelector<HTMLElement>("[data-thread-context-drop]")!;

    beginThreadDragAt(source(), center(target), 7);
    expect(target.hasAttribute("data-thread-context-over")).toBe(false);
    firePointer("pointerup", center(target));
    expect(onDrop).not.toHaveBeenCalled();

    beginThreadDragAt(source("Fix the rail"), center(target), 7);
    endThreadDrag();
    expect(onDrop).not.toHaveBeenCalled();
    expect(target.hasAttribute("data-thread-context-over")).toBe(false);
  });

  it("lets a rail zone take the drop instead of the composer", async () => {
    using _drag = endDragAfter();
    const onDrop = vi.fn();
    const zoneDrop = vi.fn();
    function Both() {
      const zoneRef = useRef<HTMLDivElement | null>(null);
      useThreadDropZone(zoneRef, () => ({ kind: "closed" }), zoneDrop);
      return (
        <div ref={zoneRef} data-thread-context-drop="true" style={{ width: 200, height: 100 }}>
          <Target onDrop={onDrop} />
        </div>
      );
    }
    await using screen = await render(<Both />, { router: false });
    const target = screen.container.querySelector<HTMLElement>("[data-thread-context-drop]")!;
    beginThreadDragAt(source("Fix the rail"), center(target), 7);
    firePointer("pointerup", center(target));
    expect(zoneDrop).toHaveBeenCalledOnce();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe("press-and-sweep across row actions", () => {
  function Rows({ apply, onClick }: { apply: (...args: unknown[]) => void; onClick: () => void }) {
    return (
      <div>
        {["a", "b", "c"].map((key) => (
          <div key={key} data-thread-key={key} style={{ height: 30 }}>
            <button
              type="button"
              {...sweepActionProps("close")}
              onPointerDown={(event) =>
                beginRowActionSweep(event, { action: "close", threadKey: key, apply })
              }
              onClick={onClick}
            >
              Close {key}
            </button>
          </div>
        ))}
      </div>
    );
  }
  const press = (button: Element) => {
    const point = center(button);
    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 7,
        button: 0,
        pointerType: "mouse",
        clientX: point.x,
        clientY: point.y,
      }),
    );
  };

  it("applies the action to every row swept, the first included, and swallows the click", async () => {
    using _drag = endDragAfter();
    const apply = vi.fn();
    const onClick = vi.fn();
    await using screen = await render(<Rows apply={apply} onClick={onClick} />, { router: false });
    const rows = [...screen.container.querySelectorAll("[data-thread-key]")];

    press(rows[0]!.querySelector("button")!);
    firePointer("pointermove", center(rows[1]!));
    firePointer("pointermove", center(rows[2]!));
    firePointer("pointermove", center(rows[1]!));
    firePointer("pointerup", center(rows[2]!));
    rows[2]!.querySelector("button")!.click();

    expect(apply).toHaveBeenCalledExactlyOnceWith("close", ["a", "b", "c"]);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.container.querySelector("[data-sweep-hit]")).toBeNull();
  });

  it("leaves a press that stays on its row as a plain click", async () => {
    using _drag = endDragAfter();
    const apply = vi.fn();
    const onClick = vi.fn();
    await using screen = await render(<Rows apply={apply} onClick={onClick} />, { router: false });
    const button = screen.container.querySelector("button")!;

    press(button);
    firePointer("pointerup", center(button));
    button.click();

    expect(apply).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies nothing when the sweep is cancelled with Escape", async () => {
    using _drag = endDragAfter();
    const apply = vi.fn();
    await using screen = await render(<Rows apply={apply} onClick={() => {}} />, { router: false });
    const rows = [...screen.container.querySelectorAll("[data-thread-key]")];

    press(rows[0]!.querySelector("button")!);
    firePointer("pointermove", center(rows[1]!));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    firePointer("pointerup", center(rows[1]!));

    expect(apply).not.toHaveBeenCalled();
  });
});

describe("dropping files on a rail row", () => {
  const thread = {
    id: "t1",
    environmentId: "env-1",
    title: "Fix the rail",
  } as unknown as EnvironmentThreadShell;

  function Row() {
    const drop = useRowFileDrop(thread);
    return (
      <div data-testid="row" data-over={drop.over || undefined} {...drop.handlers}>
        row
      </div>
    );
  }

  function dropEvent(type: string, files: File[]) {
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
  }

  it("adds the files to that thread's draft and highlights the row while they hover", async () => {
    using _drag = endDragAfter();
    await using screen = await render(<Row />, { router: false });
    const row = screen.container.querySelector<HTMLElement>("[data-testid='row']")!;
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    row.dispatchEvent(dropEvent("dragover", [file]));
    await vi.waitFor(() => expect(row.hasAttribute("data-over")).toBe(true));
    row.dispatchEvent(dropEvent("drop", [file]));
    await vi.waitFor(() => expect(row.hasAttribute("data-over")).toBe(false));

    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft({ environmentId: "env-1", threadId: "t1" } as never);
    expect(draft?.files.map((entry) => entry.name)).toEqual(["notes.txt"]);
  });

  it("ignores a drag that carries no files", async () => {
    using _drag = endDragAfter();
    await using screen = await render(<Row />, { router: false });
    const row = screen.container.querySelector<HTMLElement>("[data-testid='row']")!;
    const event = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(row.hasAttribute("data-over")).toBe(false);
  });
});
