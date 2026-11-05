import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { beginThreadDragAt, endThreadDrag } from "../../grid/threadDrag";
import { GridShelves } from "./GridShelves";

function shelfThread(id: string, title: string): EnvironmentThreadShell {
  return { id, title } as EnvironmentThreadShell;
}

const held = [
  shelfThread("held-a", "Audit release notes"),
  shelfThread("held-b", "Refresh fixtures"),
];
const closed = [shelfThread("closed-a", "Old work")];

describe("GridShelves", () => {
  it("starts collapsed with a count on each shelf", async () => {
    localStorage.clear();
    await using screen = await render(
      <GridShelves
        held={held}
        closed={closed}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      />,
      { router: false },
    );

    await expect
      .element(screen.getByRole("treeitem", { name: /On hold/ }))
      .toHaveTextContent("On hold2");
    await expect
      .element(screen.getByRole("treeitem", { name: /Closed/ }))
      .toHaveTextContent("Closed1");
    expect(screen.container.querySelectorAll('[data-testid="shelf-card"]')).toHaveLength(0);
  });

  it("marks each shelf with its archive icon and opens its list above the row", async () => {
    localStorage.clear();
    await using screen = await render(
      <GridShelves
        held={held}
        closed={closed}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      />,
      { router: false },
    );

    const onHold = screen.container.querySelector('[data-testid="grid-snoozed-shelf-toggle"]');
    const closedRow = screen.container.querySelector('[data-testid="grid-settled-shelf-toggle"]');
    expect(onHold?.querySelector('[data-shelf-icon="snoozed"]')).not.toBeNull();
    expect(closedRow?.querySelector('[data-shelf-icon="settled"]')).not.toBeNull();

    await userEvent.click(onHold as HTMLElement);
    const onHoldList = screen.container.querySelector('[data-testid="grid-snoozed-shelf-list"]');
    const onHoldRow = screen.container.querySelector('[data-testid="grid-snoozed-shelf-toggle"]');
    expect(onHoldList).not.toBeNull();
    expect(
      Boolean(onHoldList!.compareDocumentPosition(onHoldRow!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    await userEvent.click(closedRow as HTMLElement);
    const closedList = screen.container.querySelector('[data-testid="grid-settled-shelf-list"]');
    const closedRowAfter = screen.container.querySelector(
      '[data-testid="grid-settled-shelf-toggle"]',
    );
    expect(closedList).not.toBeNull();
    expect(
      Boolean(
        closedList!.compareDocumentPosition(closedRowAfter!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("expands each shelf to its thread cards", async () => {
    localStorage.clear();
    await using screen = await render(
      <GridShelves
        held={held}
        closed={closed}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
      />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("treeitem", { name: /On hold/ }));
    await expect.element(screen.getByText("Audit release notes")).toBeVisible();
    await expect.element(screen.getByText("Refresh fixtures")).toBeVisible();

    await userEvent.click(screen.getByRole("treeitem", { name: /Closed/ }));
    await expect.element(screen.getByText("Old work")).toBeVisible();
  });

  it("draws both shelf rows alike until a thread is dragged toward Closed", async () => {
    localStorage.clear();
    const noop = () => {};
    const shelves = (closedDragActive: boolean) => (
      <GridShelves
        held={held}
        closed={closed}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
        closedDragActive={closedDragActive}
        onClosedDrop={noop}
      />
    );
    await using screen = await render(shelves(false), { router: false });

    const color = (testId: string) =>
      getComputedStyle(screen.container.querySelector(`[data-testid="${testId}"]`)!).color;
    expect(color("grid-settled-shelf-toggle")).toBe(color("grid-snoozed-shelf-toggle"));

    const shelfRow = getComputedStyle(
      screen.container.querySelector('[data-testid="grid-settled-shelf-toggle"]')!,
    );
    expect(shelfRow.transitionProperty).toContain("color");
    expect(shelfRow.transitionDuration).toBe("0.1s");
    expect(shelfRow.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");

    await screen.rerender(shelves(true));
    // The row eases its colour, so wait for the transition to land.
    await vi.waitFor(() =>
      expect(color("grid-settled-shelf-toggle")).not.toBe(color("grid-snoozed-shelf-toggle")),
    );
  });

  it("closes the thread dropped on the Closed shelf", async () => {
    localStorage.clear();
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onClosedDrop = vi.fn();
    await using screen = await render(
      <GridShelves
        held={held}
        closed={closed}
        renderCard={(thread) => <span data-testid="shelf-card">{thread.title}</span>}
        closedDragActive
        onClosedDrop={onClosedDrop}
      />,
      { router: false },
    );

    const row = screen.container.querySelector<HTMLElement>(
      '[data-testid="grid-settled-shelf-toggle"]',
    );
    if (row === null) throw new Error("closed shelf missing");
    const rect = row.getBoundingClientRect();
    const source = {
      gridId: "g-1",
      threadId: "thread-a",
      environmentId: "env-1",
      projectId: "project-1",
    };
    await act(() =>
      beginThreadDragAt(
        source,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    expect(onClosedDrop).toHaveBeenCalledWith(source);
  });
});
