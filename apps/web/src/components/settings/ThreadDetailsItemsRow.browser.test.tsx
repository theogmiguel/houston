import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { THREAD_DETAILS_ITEMS } from "../chat/threadDetailsItems";
import { ThreadDetailsItemsRow } from "./ThreadDetailsItemsRow";

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  updateClientSettings: (() => Promise.resolve()) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

describe("thread details settings row", () => {
  it("offers the same items as the thread details card menu", async () => {
    await using _screen = await render(<ThreadDetailsItemsRow />);
    await userEvent.click(page.getByRole("button", { name: /Thread details:/ }));
    for (const item of THREAD_DETAILS_ITEMS) {
      await expect.element(page.getByText(item.label)).toBeVisible();
    }
  });
});
