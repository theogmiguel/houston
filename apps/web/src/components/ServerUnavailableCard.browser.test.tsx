import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { ServerUnavailableCard } from "./ServerUnavailableCard";

const DETAIL =
  "Tried 127.0.0.1:3773 · PrimaryEnvironmentRequestError (HTTP 500) during fetch-session-state";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("ServerUnavailableCard", () => {
  it("shows a danger icon beside the title and the address and error the client got", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(<ServerUnavailableCard report="report" detail={DETAIL} />);

    const heading = screen.getByRole("heading", { name: "Houston's server isn't running" });
    const icon = heading.element().querySelector("[data-slot='standalone-page-status-icon']");
    expect(icon, "a status icon inside the title").not.toBeNull();
    const iconBox = icon!.getBoundingClientRect();
    const headingBox = heading.element().getBoundingClientRect();
    expect(iconBox.left).toBeGreaterThanOrEqual(headingBox.left);
    expect(iconBox.right).toBeLessThan(headingBox.right);
    expect(getComputedStyle(icon!).color).not.toBe(
      getComputedStyle(screen.getByText(DETAIL).element()).color,
    );

    const detail = screen.getByText(DETAIL);
    await expect.element(detail).toBeVisible();
    expect(getComputedStyle(detail.element()).fontSize).toBe("12px");
  });

  it("offers one primary action, one secondary action and a ghost Copy error", async () => {
    await using screen = await render(<ServerUnavailableCard report="report" detail={DETAIL} />);

    const paint = (name: string) => {
      const style = getComputedStyle(screen.getByRole("button", { name }).element());
      return [style.backgroundColor, style.borderTopColor];
    };
    expect(paint("Try again")).not.toEqual(paint("Reload app"));
    expect(paint("Copy error")).toEqual([TRANSPARENT, TRANSPARENT]);
    expect(paint("Reload app")[0]).not.toBe(TRANSPARENT);
  });
});
