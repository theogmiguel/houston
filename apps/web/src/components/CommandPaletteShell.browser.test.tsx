import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPaletteShell";

const load = vi.hoisted(() => ({
  gate: Promise.withResolvers<void>(),
  module: null as Promise<unknown> | null,
}));

// The palette's results load on demand; holding their module back stands in for a cold start.
vi.mock(import("./CommandPalette"), async (original) => {
  const module = original();
  load.module = module;
  await load.gate.promise;
  return module;
});

it("keeps what the user types while the palette is still loading", async () => {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

  openCommandPalette();
  const early = page.getByPlaceholder("Search commands, projects, and threads...");
  await expect.element(early).toHaveFocus();
  await userEvent.keyboard("ope");
  await expect.element(early).toHaveValue("ope");
  expect(document.querySelector('[role="combobox"]')).toBeNull();

  await vi.waitFor(() => expect(load.module).not.toBeNull(), { timeout: 10_000 });
  await load.module;
  load.gate.resolve();
  const input = page.getByRole("combobox");
  await expect.element(input).toHaveValue("ope");
  await expect.element(input).toHaveFocus();
  await userEvent.keyboard("n tasks");
  await expect.element(input).toHaveValue("open tasks");
  await expect.element(page.getByText("Open tasks", { exact: true })).toBeInTheDocument();
});
