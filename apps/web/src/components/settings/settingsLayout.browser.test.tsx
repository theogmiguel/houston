import { describe, expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { Swap } from "../ui/swap";
import { render } from "../../../test/render";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SETTINGS_SECTION_DESCRIPTIONS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

describe("SettingsPageContainer heading", () => {
  it("opens every settings page with one muted line and no visible repeat of the breadcrumb title", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/appearance" },
    );

    const title = screen.getByRole("heading", { level: 1, name: "Appearance" }).element();
    const titleBox = title.getBoundingClientRect();
    // The title stays for assistive tech and takes no room on the page.
    expect(titleBox.width).toBeLessThanOrEqual(1);
    expect(titleBox.height).toBeLessThanOrEqual(1);
    const description = screen.getByText(SETTINGS_SECTION_DESCRIPTIONS["/settings/appearance"]);
    await expect.element(description).toBeVisible();
    expect(title.compareDocumentPosition(description.element())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the title visible on a phone", async () => {
    await page.viewport(390, 800);
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/appearance" },
    );

    const title = screen.getByRole("heading", { level: 1, name: "Appearance" }).element();
    await expect.element(title).toBeVisible();
    expect(title.getBoundingClientRect().height).toBeGreaterThan(10);
  });

  it("titles the open source licenses detail page", async () => {
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/open-source-licenses" },
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Open source licenses" }).elements(),
    ).toHaveLength(1);
    await expect
      .element(screen.getByText("The third-party software this app includes."))
      .toBeVisible();
  });

  it("centres the content column in the canvas", async () => {
    const canvas = document.createElement("div");
    canvas.style.cssText = "display:flex;flex-direction:column;width:1152px;height:900px";
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/appearance", container: canvas },
    );
    const scroll = screen.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
    const column = scroll.firstElementChild as HTMLElement;
    const scrollBox = scroll.getBoundingClientRect();
    const columnBox = column.getBoundingClientRect();
    const left = columnBox.left - scrollBox.left;
    const right = scrollBox.right - columnBox.right;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  });

  it("adds no heading outside a known settings page", async () => {
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/unknown-page" },
    );

    expect(screen.getByRole("heading").elements()).toHaveLength(0);
  });

  it("describes every section that has a title in one short line", () => {
    for (const path of Object.keys(SETTINGS_SECTION_LABELS) as Array<
      keyof typeof SETTINGS_SECTION_LABELS
    >) {
      const description = SETTINGS_SECTION_DESCRIPTIONS[path];
      expect(description.length, path).toBeGreaterThan(0);
      expect(description.length, `${path} must fit on one line`).toBeLessThanOrEqual(80);
    }
  });
});

describe("SettingsBreadcrumb", () => {
  it("shows Settings / <Page> for the current settings page", async () => {
    await using screen = await render(<SettingsBreadcrumb pathname="/settings/providers" />, {
      router: "/settings/providers",
    });

    const crumbs = screen.getByRole("navigation", { name: "Settings breadcrumb" }).element();
    expect(crumbs.textContent).toBe("Settings/Providers");
    expect(crumbs.querySelector("[aria-current=page]")?.textContent).toBe("Providers");
  });

  it("names only Settings for a path without a page label", async () => {
    await using screen = await render(<SettingsBreadcrumb pathname="/settings" />, {
      router: "/settings",
    });

    const crumbs = screen.getByRole("navigation", { name: "Settings breadcrumb" }).element();
    expect(crumbs.textContent).toBe("Settings");
  });
});

describe("SettingsSection label", () => {
  it("labels a group at 14px, semibold, below full foreground emphasis", async () => {
    await using screen = await render(
      <SettingsSection title="Advanced">
        <p>content</p>
      </SettingsSection>,
      { router: "/settings/providers" },
    );

    const label = screen.getByRole("heading", { level: 2, name: "Advanced" }).element();
    const style = getComputedStyle(label);
    expect(style.fontSize).toBe("14px");
    expect(style.fontWeight).toBe("600");
    const section = label.closest("section")!;
    expect(label.getBoundingClientRect().left).toBe(section.getBoundingClientRect().left);
    // foreground/80 is a translucent colour, so its alpha is below 1.
    expect(style.color).toMatch(/^(rgba\(.*,\s*0\.8\)|color\(.*\/\s*0\.8\)|oklab\(.*\/\s*0\.8\))/);
  });
});

/** Resolves any CSS colour, translucent ones included, to the opaque RGB it paints over `base`. */
function flatten(color: string, base: string): [number, number, number] {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = base;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("settings helper text contrast", () => {
  it("keeps description text at 4.5:1 or better on the dark card", async () => {
    document.documentElement.classList.add("dark");
    using _dark = { [Symbol.dispose]: () => document.documentElement.classList.remove("dark") };
    await using screen = await render(
      <div className="bg-card">
        <p className="text-xs leading-4 text-muted-foreground">Helper text</p>
      </div>,
    );
    const text = screen.getByText("Helper text").element();
    const fill = getComputedStyle(text.parentElement!).backgroundColor;
    const [lighter, darker] = [
      luminance(flatten(getComputedStyle(text).color, fill)),
      luminance(flatten(fill, "#000")),
    ].toSorted((a, b) => b - a);
    expect((lighter! + 0.05) / (darker! + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

function resolveToken(property: "color" | "borderTopColor", value: string): string {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style[property] = value;
  const resolved = getComputedStyle(probe)[property];
  probe.remove();
  return resolved;
}

describe("settings group card", () => {
  it("separates the card from the canvas in light and reads its description at 12px and 4.5:1 in both themes", async () => {
    try {
      for (const theme of ["light", "dark"] as const) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        await using screen = await render(
          <SettingsSection title="Theme">
            <SettingsRow title="Contrast" description="Adjust the contrast across the interface." />
          </SettingsSection>,
          { router: "/settings/appearance" },
        );
        const group = document.querySelector<HTMLElement>('[data-slot="settings-group"]')!;
        const card = getComputedStyle(group);
        // The raised card edge is its own token in both themes.
        const edge = flatten(card.borderTopColor, card.backgroundColor);
        const expected = flatten(
          resolveToken("borderTopColor", "var(--card-edge)"),
          card.backgroundColor,
        );
        edge.forEach((channel, index) =>
          expect(Math.abs(channel - expected[index]!), theme).toBeLessThanOrEqual(1),
        );

        const description = screen.getByText("Adjust the contrast across the interface.").element();
        const style = getComputedStyle(description);
        expect(style.fontSize, theme).toBe("12px");
        const fill = card.backgroundColor;
        const [lighter, darker] = [
          luminance(flatten(style.color, fill)),
          luminance(flatten(fill, "#000")),
        ].toSorted((a, b) => b - a);
        expect((lighter! + 0.05) / (darker! + 0.05), theme).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });
});

describe("settings page scrolling", () => {
  it("scrolls a long page with the mouse wheel inside the route's swap layout", async () => {
    const canvas = document.createElement("div");
    canvas.style.cssText = "display:flex;flex-direction:column;width:1920px;height:1050px";
    await using screen = await render(
      <Swap
        swapKey="/settings/voice"
        className="min-h-0 flex flex-1 flex-col"
        contentClassName="min-h-0 flex flex-1 flex-col"
        innerClassName="min-h-0 flex flex-1 flex-col"
      >
        <SettingsPageContainer>
          {Array.from({ length: 60 }, (_, index) => (
            <p key={index} className="h-16">{`row ${index}`}</p>
          ))}
        </SettingsPageContainer>
      </Swap>,
      { router: "/settings/voice", container: canvas },
    );
    const scroll = screen.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.clientHeight).toBeLessThanOrEqual(1050);
    await userEvent.wheel(scroll, { delta: { y: 300 } });
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0);
  });
});
