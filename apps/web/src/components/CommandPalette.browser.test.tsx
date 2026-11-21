import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { __setClientSettingsForTests } from "../hooks/useSettings";
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

  it("offers Add project… as the last row of New thread in...", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByText("Add project…", { exact: true })).toBeInTheDocument();
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("lists Open tasks and routes it to the Tasks page", async () => {
    setup();
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "open tasks" });
    await page.getByText("Open tasks", { exact: true }).click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/tasks"));
  });
});

describe("CommandPalette language", () => {
  it("shows the search placeholder in Brazilian Portuguese", async () => {
    setup();
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, language: "pt-BR" });
    try {
      await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
      openCommandPalette({ query: "" });
      await expect
        .element(page.getByPlaceholder("Buscar comandos, projetos e threads..."))
        .toBeVisible();
    } finally {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    }
  });
});
