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
});
