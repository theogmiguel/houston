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

  it("expands each shelf in place to its thread cards", async () => {
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
