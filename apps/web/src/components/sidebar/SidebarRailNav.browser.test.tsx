import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarRailNav } from "./SidebarRailNav";

vi.mock("../../state/environments", () => ({
  usePullRequestsSupported: () => true,
}));

vi.mock("../ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/sidebar")>()),
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));

const openAddProjectDialog = vi.fn();
vi.mock("../AddProjectDialog", () => ({
  openAddProjectDialog: () => openAddProjectDialog(),
}));

describe("SidebarRailNav", () => {
  it("starts threads from a grid's + instead of a New thread row", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);

    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("New thread");
    expect(screen.getByRole("button", { name: "Pull requests" }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: "Usage" }).element()).toBeVisible();
    expect(text).toContain("Workspaces");
  });

  it("draws every navigation icon at 16px", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);

    const icon = screen
      .getByRole("button", { name: /Pull requests/ })
      .element()
      .querySelector("svg")!;
    expect(icon.getBoundingClientRect().width).toBe(16);
    expect(icon.getBoundingClientRect().height).toBe(16);
  });

  it("eases its rows on the feedback role", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);

    const style = getComputedStyle(screen.getByRole("button", { name: /Pull requests/ }).element());
    expect(style.transitionProperty).toContain("color");
    expect(style.transitionDuration).toBe("0.1s");
    expect(style.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");
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

  it("keeps Add project reachable in the section heading", async () => {
    openAddProjectDialog.mockReset();
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />);

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    expect(openAddProjectDialog).toHaveBeenCalledTimes(1);
  });

  it("folds pull requests, tasks and usage into one icon-only row under search", async () => {
    for (const width of [264, 280]) {
      await using screen = await render(
        <div style={{ width }}>
          <SidebarRailNav
            search={<span>Search</span>}
            pullRequestCount={3}
            taskCount={2}
            sectionHeading={false}
          />
        </div>,
      );
      const names = ["Pull requests, 3", "Tasks, 2", "Usage"];
      const boxes = names.map((name) =>
        screen.getByRole("button", { name }).element().getBoundingClientRect(),
      );
      // One row: equal tops and heights, side by side inside the rail, each tall enough to hit.
      for (const box of boxes) {
        expect(box.top).toBe(boxes[0]!.top);
        expect(box.height).toBe(28);
        expect(box.width).toBeGreaterThan(40);
      }
      const rail = screen.container.firstElementChild!.getBoundingClientRect();
      expect(boxes[2]!.right).toBeLessThanOrEqual(rail.right + 0.5);
      expect(boxes[0]!.left).toBeGreaterThanOrEqual(rail.left - 0.5);
      // Search plus the icon-only shortcut row.
      const shortcuts = screen.container.querySelector("[data-rail-shortcuts]")!;
      expect(shortcuts.getBoundingClientRect().height).toBe(28);
      for (const name of names) {
        const button = screen.getByRole("button", { name }).element();
        expect(button.querySelector("[data-rail-shortcut-label]")).toBeNull();
        expect(button.textContent ?? "").toBe(name.match(/\d+$/)?.[0] ?? "");
      }
      expect(rail.height).toBeLessThanOrEqual(66);
    }
  });

  it("marks the shortcut of the current page and reaches each one with the keyboard", async () => {
    await using screen = await render(<SidebarRailNav search={<span>Search</span>} />, {
      router: "/tasks",
    });
    await expect
      .poll(() =>
        screen.getByRole("button", { name: "Tasks" }).element().getAttribute("aria-current"),
      )
      .toBe("page");
    expect(
      screen.getByRole("button", { name: "Usage" }).element().hasAttribute("aria-current"),
    ).toBe(false);

    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pull requests");
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Tasks");
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Usage");
  });

  it("names each shortcut in a tooltip, with its keybinding when it has one", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarRailNav search={<span>Search</span>} />
      </TooltipProvider>,
    );

    await userEvent.hover(screen.getByRole("button", { name: "Pull requests" }).element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
        "Pull requests",
      ),
    );

    await userEvent.hover(screen.getByRole("button", { name: "Usage" }).element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toMatch(
        /^Usage · /,
      ),
    );
  });
});
