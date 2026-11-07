import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

describe("SettingsSidebarNav at a 900px-high window", () => {
  async function mount() {
    await page.viewport(1440, 900);
    return render(
      <SidebarProvider>
        <div style={{ height: 900, display: "flex" }}>
          <SettingsSidebarNav pathname="/settings/providers" />
        </div>
      </SidebarProvider>,
      { router: "/settings/providers" },
    );
  }

  it("keeps every section label fully visible without scrolling", async () => {
    await using screen = await mount();

    const footer = screen.container.querySelector<HTMLElement>('[data-sidebar="footer"]')!;
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!;
    expect(viewport.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      footer.getBoundingClientRect().top + 1,
    );
    const last = [...screen.container.querySelectorAll<HTMLElement>("[data-settings-section]")].at(
      -1,
    )!;
    // The last row ends above the point where the bottom fade would begin.
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
    expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight);
  });

  it("brings the last row fully above the footer once scrolled to the end", async () => {
    await using screen = await mount();

    const footer = screen.container.querySelector<HTMLElement>('[data-sidebar="footer"]')!;
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!;
    viewport.scrollTop = viewport.scrollHeight;
    const last = [...screen.container.querySelectorAll<HTMLElement>("[data-settings-section]")].at(
      -1,
    )!;
    await expect
      .poll(() => last.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(footer.getBoundingClientRect().top);
  });
});

describe("SettingsBreadcrumb beside the nav", () => {
  it("is hidden from md up on a page the nav lists, where the nav marks the location", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(<SettingsBreadcrumb pathname="/settings/providers" />, {
      router: "/settings/providers",
    });

    const crumbs = screen.container.querySelector<HTMLElement>("nav")!;
    expect(getComputedStyle(crumbs).display).toBe("none");
  });

  it("stays visible below md, where the nav is an icon rail", async () => {
    await page.viewport(600, 900);
    await using screen = await render(<SettingsBreadcrumb pathname="/settings/providers" />, {
      router: "/settings/providers",
    });

    const crumbs = screen.container.querySelector<HTMLElement>("nav")!;
    expect(getComputedStyle(crumbs).display).not.toBe("none");
  });

  it("stays visible for a page the nav does not list", async () => {
    await page.viewport(1440, 900);
    await using screen = await render(
      <SettingsBreadcrumb pathname="/settings/open-source-licenses" />,
      {
        router: "/settings/open-source-licenses",
      },
    );

    const crumbs = screen.container.querySelector<HTMLElement>("nav")!;
    expect(getComputedStyle(crumbs).display).not.toBe("none");
  });
});
