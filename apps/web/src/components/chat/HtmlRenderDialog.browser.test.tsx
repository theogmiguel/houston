import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

describe("HtmlRenderDialog", () => {
  it("zooms, resets and closes on Escape", async () => {
    const onClose = vi.fn();
    await using screen = await render(
      <HtmlRenderDialog src="about:blank" title="ci-time" onClose={onClose} />,
      { router: false },
    );

    await expect.element(screen.getByRole("dialog")).toBeVisible();
    await expect.element(screen.getByText("ci-time.html")).toBeVisible();
    await expect.element(screen.getByText("100%")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await expect.element(screen.getByText("125%")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    await expect.element(screen.getByText("100%")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await expect.element(screen.getByText("75%")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
