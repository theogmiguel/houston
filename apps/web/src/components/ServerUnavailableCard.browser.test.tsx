import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { ServerUnavailableCard } from "./ServerUnavailableCard";

const DETAIL = "Couldn't reach the server at localhost:10443.";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("ServerUnavailableCard", () => {
  it("shows a danger icon beside the title and a one-sentence detail", async () => {
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

  it("wraps a long sentence inside the card instead of overflowing it", async () => {
    await page.viewport(390, 800);
    const detail = "Couldn't reach the server at houston-server.internal.example.test:10443.";
    await using screen = await render(<ServerUnavailableCard report="report" detail={detail} />);

    const line = screen.container.querySelector<HTMLElement>(
      "[data-slot='standalone-page-detail']",
    )!;
    expect(line.textContent).toBe(detail);
    expect(line.textContent).not.toContain("PrimaryEnvironmentRequestError");
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("shows a settled offline rail with no loading shimmer", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(<ServerUnavailableCard report="report" detail={DETAIL} />);

    const sidebar = screen.container.querySelector<HTMLElement>(
      "[data-server-unavailable-sidebar]",
    )!;
    const offline = sidebar.querySelector<HTMLElement>("[data-server-unavailable-offline-row]")!;
    expect(offline.textContent).toBe("Server offline");
    expect(getComputedStyle(offline).opacity).toBe("1");
    // Nothing on the rail animates while the server is down.
    expect(sidebar.getAnimations({ subtree: true })).toHaveLength(0);
    expect(offline.querySelectorAll("[class*='animate-']")).toHaveLength(0);
  });

  it("puts the message on the flat canvas, on the composer's column, with every action reachable", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(<ServerUnavailableCard report="report" detail={DETAIL} />);

    const shell = screen.container.querySelector<HTMLElement>("[data-server-unavailable-shell]")!;
    const header = shell.querySelector<HTMLElement>("[data-server-unavailable-header]")!;
    const canvas = shell.querySelector<HTMLElement>("[data-server-unavailable-canvas]")!;
    const card = shell.querySelector<HTMLElement>("[data-server-unavailable-card]")!;
    expect(header).not.toBeNull();
    expect(canvas.contains(card)).toBe(true);
    // The shell already names the app; the message does not repeat the brand line.
    expect(card.querySelector('[role="img"][aria-label="Houston"]')).toBeNull();

    // Flat canvas: no card border, radius or lifted fill around the message.
    expect(getComputedStyle(canvas).borderTopWidth).toBe("0px");
    expect(getComputedStyle(canvas).borderTopLeftRadius).toBe("0px");
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const canvasGround = getComputedStyle(probe).backgroundColor;
    probe.remove();
    expect(getComputedStyle(canvas).backgroundColor).toBe(canvasGround);
    expect(getComputedStyle(card).borderTopWidth).toBe("0px");

    // The message lane is the composer column, centred in the canvas.
    const lane = card.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    expect(lane.width).toBeLessThanOrEqual(760);
    expect(
      Math.abs(lane.left + lane.width / 2 - (canvasBox.left + canvasBox.width / 2)),
    ).toBeLessThan(2);

    for (const name of ["Try again", "Reload app", "Copy error"]) {
      const button = screen.getByRole("button", { name });
      await expect.element(button).toBeVisible();
      expect(button.element().hasAttribute("disabled")).toBe(false);
    }
    await expect.element(screen.getByText("Show log")).toBeVisible();
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
