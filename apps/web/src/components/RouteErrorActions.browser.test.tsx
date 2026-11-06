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
});
