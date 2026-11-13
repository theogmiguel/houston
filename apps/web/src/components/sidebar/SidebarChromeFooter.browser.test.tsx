import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarChromeFooter } from "./SidebarChrome";
import { buildLayout } from "../../layout/layoutFixtures";
import { useLayoutStore } from "../../layout/layoutStore";

vi.mock("./SidebarUpdatePill", () => ({ SidebarUpdateArchitectureWarning: () => <></> }));
const updates = vi.hoisted(() => ({ visible: false }));
vi.mock("./SidebarUpdatesButton", () => ({
  SidebarUpdatesButton: () =>
    updates.visible ? (
      <li className="shrink-0">
        <button aria-label="Update available" className="size-7" type="button" />
      </li>
    ) : null,
}));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => <></> }));

const renderFooter = (router = "/") =>
  render(
    <TooltipProvider delay={0}>
      <SidebarProvider defaultOpen>
        <div style={{ width: 240 }}>
          <SidebarChromeFooter />
        </div>
      </SidebarProvider>
    </TooltipProvider>,
    { router },
  );

describe("SidebarChromeFooter", () => {
  it("shows Settings then the theme button, with no page buttons", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    await using screen = await renderFooter();
    const box = (name: string | RegExp) =>
      screen.getByRole("button", { name }).element().getBoundingClientRect();
    const [settings, theme] = [box("Settings"), box(/^Theme:/)];
    expect(settings.top).toBe(theme.top);
    expect(settings.width).toBe(28);
    expect(theme.width).toBe(28);
    expect(settings.right).toBeLessThanOrEqual(theme.left);
    const footer = screen.container
      .querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!
      .getBoundingClientRect();
    expect(settings.left - footer.left).toBeLessThan(16);
    for (const name of ["Pull requests", "Tasks", "Usage", "Back"]) {
      expect(screen.getByRole("button", { name }).elements()).toHaveLength(0);
    }
  });

  it("keeps Settings and the theme button on a page route", async () => {
    await using screen = await renderFooter("/tasks");
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  });

  it("names Settings in a tooltip", async () => {
    await using screen = await renderFooter();
    await userEvent.hover(screen.getByRole("button", { name: "Settings" }).element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe("Settings"),
    );
  });

  it("opens Settings as its modal route", async () => {
    await using screen = await renderFooter();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }).element());
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/settings"),
    );
  });
});

describe("SidebarChromeFooter with an update to show", () => {
  it("puts the update icon at the far right, after the theme button", async () => {
    updates.visible = true;
    using _reset = { [Symbol.dispose]: () => void (updates.visible = false) };
    await using screen = await render(
      <TooltipProvider delay={0}>
        <SidebarProvider defaultOpen>
          <div style={{ width: 240 }}>
            <SidebarChromeFooter />
          </div>
        </SidebarProvider>
      </TooltipProvider>,
    );
    const footer = screen.container
      .querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!
      .getBoundingClientRect();
    const update = screen.getByRole("button", { name: "Update available" }).element();
    const theme = screen.getByRole("button", { name: /^Theme:/ }).element();
    const rect = update.getBoundingClientRect();
    expect(rect.left).toBeGreaterThan(theme.getBoundingClientRect().right + 8);
    expect(footer.right - rect.right).toBeLessThan(16);
  });
});
