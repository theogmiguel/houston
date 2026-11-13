import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPaletteShell";
// The shell loads its body on demand; loading it here keeps a cold transform out of the polls.
import "./CommandPalette";

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("finds the entry for connecting another app when searching for mcp", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "mcp" });

    await expect
      .element(page.getByText("Use Houston in another app (MCP)", { exact: true }))
      .toBeInTheDocument();
  });

  it("lists Open tasks and routes it to the Tasks page", async () => {
    setup();
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "open tasks" });
    await page.getByText("Open tasks", { exact: true }).click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/tasks"));
  });
});
