import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { CustomSnoozeDialogHost, requestCustomSnooze } from "./CustomSnoozeDialog";
// The host loads the form on demand; loading it here keeps a cold transform out of the polls.
import "./CustomSnoozeDialogForm";

it("opens the form on demand and resolves each request with the choice", async () => {
  await using _screen = await render(<CustomSnoozeDialogHost />);
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  const first = requestCustomSnooze();
  await expect.element(page.getByRole("dialog", { name: "Custom hold" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(first).resolves.toBeNull();
  await expect.element(page.getByRole("dialog", { name: "Custom hold" })).not.toBeInTheDocument();

  const second = requestCustomSnooze();
  await page.getByText("Duration", { exact: true }).click();
  await page.getByRole("button", { name: "Hold" }).click();
  const choice = await second;
  expect(Number.isNaN(Date.parse(choice?.snoozedUntil ?? ""))).toBe(false);
});
