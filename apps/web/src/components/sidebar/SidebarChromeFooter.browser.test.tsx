import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarChromeFooter } from "./SidebarChrome";

vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => <></>,
  SidebarUpdateArchitectureWarning: () => <></>,
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => <></> }));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => <></> }));

const renderFooter = (hideTasks = false, router = "/") =>
  render(
    <TooltipProvider delay={0}>
      <SidebarProvider defaultOpen>
        <div style={{ width: 240 }}>
          <SidebarChromeFooter hideTasks={hideTasks} />
        </div>
      </SidebarProvider>
    </TooltipProvider>,
    { router },
  );

describe("SidebarChromeFooter", () => {
  it("holds Settings, Pull requests, Tasks, Usage and the theme button in one icon row", async () => {
    await using screen = await renderFooter();
    const names = ["Settings", "Pull requests", "Tasks", "Usage"];
    const boxes = names.map((name) =>
      screen.getByRole("button", { name }).element().getBoundingClientRect(),
    );
    const theme = screen
      .getByRole("button", { name: /^Theme:/ })
      .element()
      .getBoundingClientRect();
    for (const box of [...boxes, theme]) {
      expect(box.top).toBe(boxes[0]!.top);
      expect(box.width).toBe(28);
    }
    const footer = screen.container.firstElementChild!.getBoundingClientRect();
    expect(theme.right).toBeLessThanOrEqual(footer.right + 0.5);
  });

  it("drops Tasks on the phone's home", async () => {
    await using screen = await renderFooter(true);
    expect(screen.getByRole("button", { name: "Tasks" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Usage" }).element()).toBeVisible();
  });

  it("marks the button of the page on screen with aria-current", async () => {
    await using screen = await renderFooter(false, "/tasks");
    await expect
      .poll(() =>
        screen.getByRole("button", { name: "Tasks" }).element().getAttribute("aria-current"),
      )
      .toBe("page");
    expect(
      screen.getByRole("button", { name: "Usage" }).element().hasAttribute("aria-current"),
    ).toBe(false);
    // On a page the footer swaps Settings and the theme button for Back, and keeps the pages.
    await expect.element(screen.getByRole("button", { name: "Back" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" }).elements()).toHaveLength(0);
  });

  it("names each button in a tooltip, with its keybinding when it has one", async () => {
    await using screen = await renderFooter();
    await userEvent.hover(screen.getByRole("button", { name: "Pull requests" }).element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
        "Pull requests",
      ),
    );
  });
});
