import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => (atom === primaryServerKeybindingsAtom ? [] : null)) as never,
}));

// The footer's update pills and undo notice read live atoms; the border is the footer's own.
vi.mock(import("./SidebarUpdatePill"), () => ({
  SidebarUpdatePill: () => <></>,
  SidebarUpdateArchitectureWarning: () => <></>,
}));
vi.mock(import("./SidebarProviderUpdatePill"), () => ({
  SidebarProviderUpdatePill: () => <></>,
}));
vi.mock(import("./SidebarThreadUndoNotice"), () => ({ SidebarThreadUndoNotice: () => <></> }));

describe("SidebarChromeHeader", () => {
  it("draws the board's brand row: a 22px mark, Houston and the hide button", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarChromeHeader isDesktopHost={false} />
      </SidebarProvider>,
    );

    const mark = screen.container.querySelector("img");
    expect(mark).not.toBeNull();
    const style = getComputedStyle(mark as HTMLImageElement);
    expect(style.width).toBe("22px");
    expect(style.height).toBe("22px");

    await expect.element(screen.getByText("Houston")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add project" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "View options" }).elements()).toHaveLength(0);
    expect(screen.container.querySelector("[data-stage-art]")).toBeNull();
  });

  it("draws the hide button's icon at the 16px, 2.5-stroke weight of the other chrome icons", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarChromeHeader isDesktopHost={false} />
      </SidebarProvider>,
    );

    const icon = screen
      .getByRole("button", { name: "Hide sidebar" })
      .element()
      .querySelector("svg");
    expect(icon).not.toBeNull();
    const rect = (icon as SVGSVGElement).getBoundingClientRect();
    expect(rect.width).toBe(16);
    expect(rect.height).toBe(16);
    expect(icon?.getAttribute("stroke-width")).toBe("2.5");
  });
});

describe("SidebarChromeFooter", () => {
  it("is separated from the thread list by a 1px border", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarChromeFooter />
      </SidebarProvider>,
    );

    const footer = screen.container.querySelector<HTMLElement>("[data-slot=sidebar-footer]")!;
    const style = getComputedStyle(footer);
    expect(style.borderTopWidth).toBe("1px");
    expect(style.borderTopStyle).toBe("solid");
    expect(style.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});
