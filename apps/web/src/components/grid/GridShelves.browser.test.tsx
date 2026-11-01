import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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
});
