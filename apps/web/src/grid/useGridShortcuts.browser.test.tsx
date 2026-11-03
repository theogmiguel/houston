import "~/index.css";
import type { ResolvedKeybindingsConfig } from "@houston-app/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { GridRecord } from "./gridStore";
import { useGridStore } from "./gridStore";
import { threadLeaf } from "./tree";
import { useGridShortcuts } from "./useGridShortcuts";

const mod = {
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

const keybindings: ResolvedKeybindingsConfig = [
  { command: "navigation.back", shortcut: { ...mod, key: "[" } },
  { command: "navigation.forward", shortcut: { ...mod, key: "]" } },
  { command: "view.reopenClosed", shortcut: { ...mod, key: "t", shiftKey: true } },
  { command: "grid.toggleMaximizedCell", shortcut: { ...mod, key: "enter", shiftKey: true } },
  ...(
    [
      ["grid.tidy", "y"],
      ["grid.tidyRow", "h"],
      ["grid.tidyColumn", "v"],
      ["grid.equalize", "="],
    ] as const
  ).map(([command, key]) => ({
    command,
    shortcut: {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
      key,
    },
    whenAst: {
      type: "and" as const,
      left: { type: "not" as const, node: { type: "identifier" as const, name: "terminalFocus" } },
      right: { type: "not" as const, node: { type: "identifier" as const, name: "editableFocus" } },
    },
  })),
];

function grid(): GridRecord {
  return {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: {
      kind: "split",
      dir: "row",
      children: [
        threadLeaf("thread-a", "p1"),
        threadLeaf("thread-b", "p2"),
        threadLeaf("thread-c", "p3"),
      ],
      weights: [100 / 3, 100 / 3, 100 / 3],
    },
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function shapeOf(record: GridRecord): string {
  const tree = record.tree;
  if (tree === null || tree.kind !== "split") return "single";
  return `${tree.dir}:${tree.children.map((c) => (c.kind === "split" ? c.children.length : 1)).join(",")}`;
}

function Harness() {
  const [maximizedThreadId, setMaximizedThreadId] = useState<string | null>(null);
  const current = useGridStore((store) => store.grids.find((entry) => entry.id === "g-1") ?? null);
  useGridShortcuts({
    gridId: "g-1",
    keybindings,
    maximizedThreadId,
    setMaximizedThreadId,
    isThreadAvailable: () => true,
  });
  return (
    <>
      <div data-testid="focus">{current?.focusedThreadId ?? "none"}</div>
      <div data-testid="maximized">{maximizedThreadId ?? "none"}</div>
      <div data-testid="shape">
        {current?.tree === null || !current ? "none" : shapeOf(current)}
      </div>
      <textarea aria-label="Composer" />
      <button
        type="button"
        onClick={() =>
          useGridStore.getState().closeGridCell("g-1", current?.focusedThreadId ?? "thread-a")
        }
      >
        Close focused
      </button>
    </>
  );
}

describe("useGridShortcuts", () => {
  it("moves focus to the previous and next cell in reading order", async () => {
    useGridStore.setState({ grids: [grid()], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.keyboard("{Control>}{[}{/Control}");
    expect(screen.getByTestId("focus").element().textContent).toBe("thread-c");

    await userEvent.keyboard("{Control>}{]}{/Control}");
    expect(screen.getByTestId("focus").element().textContent).toBe("thread-a");
  });

  it("maximizes and restores the focused cell", async () => {
    useGridStore.setState({ grids: [grid()], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(screen.getByTestId("maximized").element().textContent).toBe("thread-a");

    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(screen.getByTestId("maximized").element().textContent).toBe("none");
  });

  it("reopens the most recently closed cell at its slot", async () => {
    useGridStore.setState({ grids: [grid()], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Close focused" }));
    expect(screen.getByTestId("focus").element().textContent).toBe("thread-b");

    await userEvent.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    expect(screen.getByTestId("focus").element().textContent).toBe("thread-a");
    expect(useGridStore.getState().closedCells["g-1"]).toBeUndefined();
  });

  it("tidies with Y, H and V while no field has focus", async () => {
    useGridStore.setState({ grids: [grid()], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });
    const shape = () => screen.getByTestId("shape").element().textContent;

    await userEvent.keyboard("v");
    expect(shape()).toBe("col:1,1,1");
    await userEvent.keyboard("h");
    expect(shape()).toBe("row:1,1,1");
    await userEvent.keyboard("y");
    expect(shape()).toBe("col:2,1");
  });

  it("resets uneven splits with = and leaves maximize", async () => {
    const uneven = grid();
    if (uneven.tree?.kind === "split") uneven.tree = { ...uneven.tree, weights: [70, 20, 10] };
    useGridStore.setState({ grids: [uneven], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(screen.getByTestId("maximized").element().textContent).toBe("thread-a");
    await userEvent.keyboard("=");
    const tree = useGridStore.getState().grids[0]!.tree!;
    expect(tree.kind === "split" && tree.weights.map((w) => Math.round(w))).toEqual([33, 33, 33]);
    expect(screen.getByTestId("maximized").element().textContent).toBe("none");
  });

  it("never rearranges the grid while typing in the composer", async () => {
    useGridStore.setState({ grids: [grid()], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.click(screen.getByRole("textbox", { name: "Composer" }));
    await userEvent.keyboard("yhv=");
    expect(screen.getByTestId("shape").element().textContent).toBe("row:1,1,1");
    expect(
      (screen.getByRole("textbox", { name: "Composer" }).element() as HTMLTextAreaElement).value,
    ).toBe("yhv=");
  });

  it("does nothing for a single-pane grid", async () => {
    const single = grid();
    single.tree = threadLeaf("thread-a", "p1");
    useGridStore.setState({ grids: [single], closedCells: {}, threadOrigins: {} });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.keyboard("v");
    expect(screen.getByTestId("shape").element().textContent).toBe("single");
  });
});
