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

  it("gives Reload app and Copy error one secondary look beside the single primary", async () => {
    await using screen = await render(<RouteErrorActions report="report" />);

    const look = (name: string) => {
      const style = getComputedStyle(screen.getByRole("button", { name }).element());
      return [style.backgroundColor, style.borderTopColor, style.color];
    };
    expect(look("Reload app")).toEqual(look("Copy error"));
    expect(look("Try again")).not.toEqual(look("Reload app"));
  });
});
