import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { RedactedSensitiveText, redactedPlaceholder } from "./RedactedSensitiveText";

const VALUE = "theo@example.com";

async function renderRedacted() {
  return await render(
    <RedactedSensitiveText
      ariaLabel="API token"
      hideTooltip="Hide token"
      revealTooltip="Reveal token"
      value={VALUE}
    />,
    { router: false },
  );
}

describe("RedactedSensitiveText", () => {
  it("shows the placeholder until pressed, then reveals and re-hides the value", async () => {
    await using screen = await renderRedacted();
    const button = screen.getByRole("button", { name: "API token" });

    expect(button.element().textContent).toBe(redactedPlaceholder(VALUE));

    await userEvent.click(button);
    expect(screen.getByRole("button", { name: "API token" }).element().textContent).toBe(VALUE);

    await userEvent.click(screen.getByRole("button", { name: "API token" }));
    expect(screen.getByRole("button", { name: "API token" }).element().textContent).toBe(
      redactedPlaceholder(VALUE),
    );
  });

  it("names the action the tooltip will take", async () => {
    await using screen = await renderRedacted();
    const button = screen.getByRole("button", { name: "API token" });

    await userEvent.hover(button);
    await expect.element(page.getByText("Reveal token")).toBeVisible();

    await userEvent.click(button);
    await userEvent.unhover(button);
    await userEvent.hover(button);
    await expect.element(page.getByText("Hide token")).toBeVisible();
  });
});
