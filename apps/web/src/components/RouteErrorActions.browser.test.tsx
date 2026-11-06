import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { RouteErrorActions } from "./RouteErrorActions";

describe("RouteErrorActions", () => {
  it("sizes the recovery buttons as standard controls and marks Try again with a retry icon", async () => {
    await using screen = await render(<RouteErrorActions report="report" />);

    for (const name of ["Try again", "Reload app", "Copy error"]) {
      const style = getComputedStyle(screen.getByRole("button", { name }).element());
      expect(style.height, name).toBe("28px");
      expect(style.fontSize, name).toBe("13px");
    }
    expect(
      screen.getByRole("button", { name: "Try again" }).element().querySelector("svg"),
    ).not.toBeNull();
  });

  it("keeps Try again primary, Reload app secondary and Copy error a borderless ghost action", async () => {
    await using screen = await render(<RouteErrorActions report="report" />);

    const look = (name: string) => {
      const style = getComputedStyle(screen.getByRole("button", { name }).element());
      return [style.backgroundColor, style.borderTopColor, style.color];
    };
    expect(look("Try again")).not.toEqual(look("Reload app"));
    expect(look("Copy error")).not.toEqual(look("Reload app"));

    const ghost = getComputedStyle(screen.getByRole("button", { name: "Copy error" }).element());
    const secondary = getComputedStyle(
      screen.getByRole("button", { name: "Reload app" }).element(),
    );
    expect(ghost.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(ghost.borderTopColor).toBe("rgba(0, 0, 0, 0)");
    expect(secondary.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});
