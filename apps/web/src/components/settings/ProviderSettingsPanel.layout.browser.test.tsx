import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  PROVIDER_DETAIL_SPLIT_CLASS,
  PROVIDER_SETTINGS_PAGE_WIDTH,
} from "./ProviderSettingsPanel.logic";
import { SettingsPageContainer } from "./settingsLayout";

vi.mock(import("./SettingsScopeSentence"), async (original) => ({
  ...(await original()),
  SettingsScopeSentence: (() => null) as never,
}));

// The provider page's own width must clear the container query that puts the selected
// provider's detail beside the list; below it the detail stacks under every provider.
it("shows a selected provider's detail beside the list in a desktop window", async () => {
  await page.viewport(1280, 900);
  await using _screen = await render(
    <SettingsPageContainer width={PROVIDER_SETTINGS_PAGE_WIDTH} className="@container/providers">
      <div className={PROVIDER_DETAIL_SPLIT_CLASS}>
        <div data-testid="provider-list">list</div>
        <div data-testid="provider-detail">detail</div>
      </div>
    </SettingsPageContainer>,
    { router: "/settings/providers" },
  );

  const list = page.getByTestId("provider-list").element().getBoundingClientRect();
  const detail = page.getByTestId("provider-detail").element().getBoundingClientRect();
  expect(detail.top).toBe(list.top);
  expect(detail.left).toBeGreaterThanOrEqual(list.right);
});
