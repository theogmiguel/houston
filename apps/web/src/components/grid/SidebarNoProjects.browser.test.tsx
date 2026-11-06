import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { SidebarNoProjects } from "./SidebarNoProjects";

const openAddProjectDialog = vi.fn();
vi.mock("../AddProjectDialog", () => ({
  openAddProjectDialog: () => openAddProjectDialog(),
}));

describe("SidebarNoProjects", () => {
  it("says there are no projects and opens the add-project dialog from its button", async () => {
    openAddProjectDialog.mockReset();
    await using screen = await render(<SidebarNoProjects />, { router: false });

    await expect.element(screen.getByText("No projects yet")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    expect(openAddProjectDialog).toHaveBeenCalledTimes(1);
  });
});
