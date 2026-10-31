import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { WindowControls } from "./window-control";

const SQUARE_GLYPH_D = "M1 1v8h8V1H1zm7 7H2V2h6v6z";

function width(element: Element): number {
  return element.getBoundingClientRect().width;
}

function height(element: Element): number {
  return element.getBoundingClientRect().height;
}

describe("WindowControls", () => {
  it("renders exactly the buttons the layout names, in its order", async () => {
    await using screen = await render(
      <WindowControls layout={{ side: "left", buttons: ["close", "minimize", "maximize"] }} />,
      { router: false },
    );

    const buttons = Array.from(
      screen.getByTestId("window-controls").element().querySelectorAll("button"),
    );
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Close",
      "Minimize",
      "Maximize",
    ]);
  });

  it("gives every disc a hover treatment and makes close destructive", async () => {
    await using screen = await render(
      <WindowControls layout={{ side: "right", buttons: ["minimize", "close"] }} />,
      { router: false },
    );

    const disc = (label: string) =>
      screen.container.querySelector(
        `button[aria-label="${label}"] [data-testid="window-control-disc"]`,
      );

    expect(disc("Minimize")?.className).toContain("group-hover/wc:bg-");
    expect(disc("Close")?.className).toContain("group-hover/wc:bg-");
    expect(disc("Close")?.className).toContain("destructive");
    expect(disc("Minimize")?.className).not.toContain("destructive");
  });

  it("rings the disc on keyboard focus and deepens the wash on press", async () => {
    await using screen = await render(
      <WindowControls layout={{ side: "right", buttons: ["close"] }} />,
      { router: false },
    );

    const disc = screen.getByTestId("window-control-disc").element();
    expect(disc.className).toContain("group-focus-visible/wc:outline-");
    expect(disc.className).toContain("group-active/wc:bg-");

    const button = screen.getByRole("button", { name: "Close" }).element();
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("draws a 30 x 40 hit area around a 20px rounded-square disc", async () => {
    await using screen = await render(
      <WindowControls layout={{ side: "right", buttons: ["minimize"] }} />,
      { router: false },
    );

    const button = screen.getByRole("button", { name: "Minimize" }).element();
    const disc = screen.getByTestId("window-control-disc").element();

    expect(width(button)).toBe(30);
    expect(height(button)).toBe(40);
    expect(width(disc)).toBe(20);
    expect(height(disc)).toBe(20);
    expect(getComputedStyle(disc).borderRadius).toBe("4px");
  });

  it("maximize swaps to the restore glyph and name; minimize and close keep theirs", async () => {
    await using screen = await render(
      <WindowControls
        layout={{ side: "right", buttons: ["minimize", "maximize", "close"] }}
        maximized
      />,
      { router: false },
    );

    expect(screen.container.querySelector('button[aria-label="Maximize"]')).toBeNull();
    const restore = screen.getByRole("button", { name: "Restore" }).element();
    const path = restore.querySelector("path")?.getAttribute("d") ?? "";
    expect(path).not.toBe(SQUARE_GLYPH_D);
    expect(path.match(/[Vv]/g)?.length ?? 0).toBeGreaterThan(2);
    expect(screen.getByRole("button", { name: "Minimize" }).element()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" }).element()).toBeTruthy();
  });

  it("an empty layout renders nothing at all", async () => {
    await using screen = await render(<WindowControls layout={{ side: "right", buttons: [] }} />, {
      router: false,
    });

    expect(screen.container.querySelector('[data-testid="window-controls"]')).toBeNull();
    expect(screen.container.innerHTML).toBe("");
  });

  it("routes each click to its own handler", async () => {
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    const onMaximize = vi.fn();

    await using screen = await render(
      <WindowControls
        layout={{ side: "right", buttons: ["minimize", "maximize", "close"] }}
        onClose={onClose}
        onMinimize={onMinimize}
        onMaximize={onMaximize}
      />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onMaximize).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(onMaximize).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
