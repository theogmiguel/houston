import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { requestConfirmDialog } from "../confirmDialog";
import { render } from "../../test/render";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

describe("ConfirmDialogHost", () => {
  it("names the confirm button after the request's label", async () => {
    await using _screen = await render(<ConfirmDialogHost />);
    void requestConfirmDialog("Delete the workspace “Drop” and its 2 threads?", {
      variant: "destructive",
      confirmLabel: "Delete workspace",
    });
    await expect.element(page.getByRole("button", { name: "Delete workspace" })).toBeVisible();
    expect(page.getByRole("button", { name: "Confirm" }).elements()).toHaveLength(0);
  });

  it("keeps Confirm when the request names no label", async () => {
    await using _screen = await render(<ConfirmDialogHost />);
    void requestConfirmDialog("Remove it?");
    await expect.element(page.getByRole("button", { name: "Confirm" })).toBeVisible();
  });
});
