import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SettingsPageContainer } from "./settingsLayout";
import { SETTINGS_SECTION_DESCRIPTIONS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

describe("SettingsPageContainer heading", () => {
  it("opens every settings page with its title and one muted line", async () => {
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/appearance" },
    );

    const title = screen.getByRole("heading", { level: 1, name: "Appearance" }).element();
    const style = getComputedStyle(title);
    expect(style.fontSize).toBe("20px");
    expect(style.fontWeight).toBe("600");
    const description = screen.getByText(SETTINGS_SECTION_DESCRIPTIONS["/settings/appearance"]);
    await expect.element(description).toBeVisible();
    expect(title.compareDocumentPosition(description.element())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("titles the open source licenses detail page", async () => {
    await using screen = await render(
      <SettingsPageContainer>
        <p>content</p>
      </SettingsPageContainer>,
      { router: "/settings/open-source-licenses" },
    );

    await expect
      .element(screen.getByRole("heading", { level: 1, name: "Open source licenses" }))
      .toBeVisible();
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
