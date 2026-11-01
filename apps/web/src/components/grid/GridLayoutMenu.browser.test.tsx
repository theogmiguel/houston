import "~/index.css";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { GridRecord } from "../../grid/gridStore";
import { type LayoutNode, threadLeaf } from "../../grid/tree";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { GridLayoutMenu } from "./GridLayoutMenu";

function grid(tree: LayoutNode | null): GridRecord {
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
  };
}

function threeThreads(): LayoutNode {
  return {
    kind: "split",
    dir: "row",
    children: [
      threadLeaf("thread-a", "p1"),
      threadLeaf("thread-b", "p2"),
      threadLeaf("thread-c", "p3"),
    ],
    weights: [100 / 3, 100 / 3, 100 / 3],
  };
}

describe("GridLayoutMenu", () => {
  it("enables the preset for the current count and explains the others", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <GridLayoutMenu grid={grid(threeThreads())} />
      </TooltipProvider>,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Grid layout" }));

    const matching = page.getByRole("menuitem", { name: /^3 threads/ });
    await expect.element(matching).toBeVisible();
    expect(matching.element().getAttribute("data-disabled")).toBeNull();

    const other = page.getByRole("menuitem", { name: /^4 threads/ });
    await expect.element(other).toBeVisible();
    expect(other.element().getAttribute("data-disabled")).not.toBeNull();
    expect(other.element().textContent).toContain("Needs 4 · grid has 3");
  });
});
