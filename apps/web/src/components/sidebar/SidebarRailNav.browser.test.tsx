import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarRailNav } from "./SidebarRailNav";

describe("SidebarRailNav", () => {
  it("draws the search field and its buttons on one row, the field taking the remaining width", async () => {
    await using screen = await render(
      <div style={{ width: 264 }}>
        <SidebarRailNav
          search={<span>Search</span>}
          actions={
            <>
              <button type="button" aria-label="One" className="size-7" />
              <button type="button" aria-label="Two" className="size-7" />
            </>
          }
        />
      </div>,
    );

    const row = screen.container.querySelector("[data-rail-search-row]")!.getBoundingClientRect();
    const field = screen.getByText("Search").element().getBoundingClientRect();
    const buttons = ["One", "Two"].map((name) =>
      screen.getByRole("button", { name }).element().getBoundingClientRect(),
    );
    expect(row.height).toBe(28);
    for (const box of buttons) expect(box.top).toBe(row.top);
    expect(buttons[1]!.right).toBeLessThanOrEqual(row.right + 0.5);
    expect(field.right).toBeLessThanOrEqual(buttons[0]!.left);
  });

  it("draws no Pull requests, Tasks or Usage buttons, which live in the footer", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);
    expect(screen.container.querySelector("button")).toBeNull();
  });
});
