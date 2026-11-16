import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { QuitShortcutSetting } from "./QuitShortcutSetting";

vi.mock(import("../../env"), async (original) => ({ ...(await original()), isDesktopHost: true }));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));

it("renders the quit shortcut row in the desktop host", async () => {
  await using screen = await render(<QuitShortcutSetting />);

  await expect.element(screen.getByText("Quit shortcut")).toBeVisible();
});
