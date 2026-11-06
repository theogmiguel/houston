import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const mod = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  return {
    primaryServerKeybindingsAtom: Atom.make([
      { command: "grid.tidy", shortcut: { ...mod, key: "y" } },
      { command: "grid.tidyRow", shortcut: { ...mod, key: "h" } },
      { command: "grid.tidyColumn", shortcut: { ...mod, key: "v" } },
    ]),
  } as never;
});

import { type GridRecord, useGridStore } from "../../grid/gridStore";
import { type LayoutNode, preorderLeaves, threadLeaf } from "../../grid/tree";
import { render } from "../../../test/render";
import { Button } from "../ui/button";
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

function threads(ids: string[]): LayoutNode {
  return {
    kind: "split",
    dir: "row",
    children: ids.map((id) => threadLeaf(id, `p-${id}`)),
    weights: ids.map(() => 100 / ids.length),
  };
}

function seed(record: GridRecord) {
  useGridStore.setState({ grids: [record], closedCells: {}, threadOrigins: {} });
}

function current(): LayoutNode {
  return useGridStore.getState().grids[0]!.tree!;
}

async function mount(record: GridRecord, onArrange?: () => void) {
  seed(record);
  return render(
    <TooltipProvider delay={0}>
      <GridLayoutMenu grid={record} {...(onArrange ? { onArrange } : {})} />
    </TooltipProvider>,
    { router: false },
  );
}

describe("GridLayoutMenu", () => {
  it("tidies into a balanced grid on the main click, keeping thread order", async () => {
    const onArrange = vi.fn();
    await using screen = await mount(
      grid(threads(["thread-a", "thread-b", "thread-c", "thread-d", "thread-e"])),
      onArrange,
    );

    await userEvent.click(screen.getByRole("button", { name: "Tidy panes" }));

    const tree = current();
    expect(tree.kind === "split" && tree.dir).toBe("col");
    expect(tree.kind === "split" && tree.children.length).toBe(2);
    expect(preorderLeaves(tree)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
      "thread-d",
      "thread-e",
    ]);
    expect(onArrange).toHaveBeenCalledTimes(1);
  });

  it("lists the three shapes with their shortcuts and applies the chosen one", async () => {
    await using screen = await mount(grid(threads(["thread-a", "thread-b", "thread-c"])));

    await userEvent.click(screen.getByRole("button", { name: "Choose tidy layout" }));
    await expect.element(page.getByRole("menuitem", { name: /Balanced grid\s*y/i })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /One row\s*h/i })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: /One column\s*v/i }));

    const tree = current();
    expect(tree.kind === "split" && tree.dir).toBe("col");
    expect(tree.kind === "split" && tree.children.every((c) => c.kind === "thread")).toBe(true);
    expect(preorderLeaves(tree)).toEqual(["thread-a", "thread-b", "thread-c"]);
  });

  it("is disabled with a reason while the grid holds fewer than two panes", async () => {
    const single = grid(threads(["thread-a"]));
    await using screen = await mount(single);

    expect(screen.getByRole("button", { name: "Choose tidy layout" }).element()).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Tidy panes" }).element().ariaDisabled).toBe("true");
    await userEvent.hover(screen.getByRole("button", { name: "Tidy panes" }));
    await expect.element(page.getByText("Open a second pane to tidy the grid")).toBeVisible();
  });

  it("draws the main and menu buttons as one split button of equal height", async () => {
    await using screen = await mount(grid(threads(["thread-a", "thread-b"])));

    const group = screen.getByRole("group").element();
    const main = screen.getByRole("button", { name: "Tidy panes" }).element();
    const menu = screen.getByRole("button", { name: "Choose tidy layout" }).element();
    const separator = group.querySelector<HTMLElement>('[data-slot="separator"]')!;

    const groupBox = group.getBoundingClientRect();
    expect(groupBox.height).toBe(28);
    expect(main.getBoundingClientRect().height).toBe(28);
    expect(menu.getBoundingClientRect().height).toBe(28);
    expect(getComputedStyle(group).borderTopLeftRadius).toBe("6px");
    // The outline is an overlay with the same radius, so it takes no layout space.
    const outline = getComputedStyle(group, "::after");
    expect(outline.borderTopWidth).toBe("1px");
    expect(outline.borderTopLeftRadius).toBe("6px");
    expect(getComputedStyle(group).borderTopWidth).toBe("0px");
    // The container owns the outer corners: the joined edges stay square.
    expect(getComputedStyle(main).borderTopLeftRadius).toBe("6px");
    expect(getComputedStyle(main).borderTopRightRadius).toBe("0px");
    expect(getComputedStyle(menu).borderTopLeftRadius).toBe("0px");
    expect(getComputedStyle(menu).borderTopRightRadius).toBe("6px");
    expect(separator.getBoundingClientRect().width).toBe(1);
    expect(separator.getBoundingClientRect().height).toBe(28);
  });

  it("shares its top edge and height with a sibling icon button in the header row", async () => {
    seed(grid(threads(["thread-a", "thread-b"])));
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div className="flex h-10 items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Sibling" />
          <GridLayoutMenu grid={grid(threads(["thread-a", "thread-b"]))} />
        </div>
      </TooltipProvider>,
    );

    const sibling = screen.getByRole("button", { name: "Sibling" }).element().getBoundingClientRect();
    const main = screen.getByRole("button", { name: "Tidy panes" }).element().getBoundingClientRect();
    const group = screen.getByRole("group").element().getBoundingClientRect();
    expect(group.top).toBe(sibling.top);
    expect(main.top).toBe(sibling.top);
    expect(main.height).toBe(sibling.height);
    expect(group.height).toBe(sibling.height);
  });
});
