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
    expect(getComputedStyle(detail.element()).fontFamily).not.toMatch(/mono/i);
  });

  it("breaks a long detail only at the separator, never inside a part", async () => {
    await page.viewport(1440, 900);
    const detail =
      "Tried houston-server.internal.example.test:10443 · PrimaryEnvironmentRequestError (HTTP 500) during fetch-session-state";
    await using screen = await render(<ServerUnavailableCard report="report" detail={detail} />);

    const line = screen.container.querySelector<HTMLElement>(
      "[data-slot='standalone-page-detail']",
    )!;
    const parts = [...line.querySelectorAll<HTMLElement>("span")];
    expect(parts.map((part) => part.textContent)).toEqual(detail.split(" · "));
    for (const part of parts) {
      expect(part.getClientRects(), `"${part.textContent}" on one line`).toHaveLength(1);
    }
    expect(
      parts[1]!.getBoundingClientRect().top,
      "the second part starts a new line",
    ).toBeGreaterThan(parts[0]!.getBoundingClientRect().bottom - 1);
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
