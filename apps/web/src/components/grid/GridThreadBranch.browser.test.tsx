import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { GridThreadBranch } from "./GridThreadBranch";

it("drops the checkout mode, then the branch, as the viewport narrows", async () => {
  const initialWidth = window.innerWidth;
  const initialHeight = window.innerHeight;
  await using screen = await render(
    <GridThreadBranch branch="v2-polish-crumb-hover" worktreePath="/worktrees/thread" />,
  );
  const branch = screen.getByText("v2-polish-crumb-hover").element();
  const mode = screen.getByText("· worktree").element();

  try {
    await page.viewport(1000, 800);
    await vi.waitFor(() => {
      expect(branch.getClientRects().length).toBeGreaterThan(0);
      expect(mode.getClientRects().length).toBeGreaterThan(0);
    });

    await page.viewport(800, 700);
    await vi.waitFor(() => {
      expect(branch.getClientRects().length).toBeGreaterThan(0);
      expect(mode.getClientRects().length).toBe(0);
    });

    await page.viewport(600, 700);
    await vi.waitFor(() => {
      expect(branch.getClientRects().length).toBe(0);
      expect(mode.getClientRects().length).toBe(0);
    });
  } finally {
    await page.viewport(initialWidth, initialHeight);
  }
});
