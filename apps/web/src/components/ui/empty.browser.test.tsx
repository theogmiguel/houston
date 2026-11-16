import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { EmptyTitle } from "./empty";

describe("EmptyTitle display variant", () => {
  it("sets the welcome heading in the interface sans at hero size", async () => {
    await using screen = await render(
      <EmptyTitle variant="display">Add a project to start</EmptyTitle>,
      {
        router: false,
      },
    );
    const style = getComputedStyle(screen.getByText("Add a project to start").element());

    expect(style.fontFamily).toContain("Inter");
    expect(style.fontFamily).not.toContain("Serif");
    expect(style.fontSize).toBe("30px");
  });
});
