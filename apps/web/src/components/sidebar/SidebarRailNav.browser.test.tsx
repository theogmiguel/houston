import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarRailNav } from "./SidebarRailNav";

vi.mock("../../state/environments", () => ({
  usePullRequestsSupported: () => true,
}));

vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));

describe("SidebarRailNav", () => {
  it("starts threads from a grid's + instead of a New thread row", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);

    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("New thread");
    expect(text).toContain("Pull requests");
    expect(text).toContain("Usage");
    expect(text).toContain("Workspaces");
  });

  it("shows the open pull request count, and hides it when empty or unknown", async () => {
    {
      await using screen = await render(
        <SidebarRailNav search={<span>Search</span>} pullRequestCount={3} />,
      );
      expect(screen.getByRole("button", { name: /Pull requests/ }).element().textContent).toContain(
        "3",
      );
    }

    for (const count of [null, 0]) {
      await using screen = await render(
        <SidebarRailNav search={<span>Search</span>} pullRequestCount={count} />,
      );
      expect(
        screen.getByRole("button", { name: /Pull requests/ }).element().textContent,
      ).not.toMatch(/\d/);
    }
  });

  it("takes the section title and actions from its caller", async () => {
    await using screen = await render(
      <SidebarRailNav
        search={<span>Search</span>}
        sectionTitle="Grids"
        sectionActions={<button type="button">New grid</button>}
      />,
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Grids");
    expect(text).not.toContain("Workspaces");
    expect(screen.getByRole("button", { name: "New grid" }).element()).toBeVisible();
  });
});
