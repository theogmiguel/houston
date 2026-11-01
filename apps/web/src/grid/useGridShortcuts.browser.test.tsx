import "~/index.css";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
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
});
