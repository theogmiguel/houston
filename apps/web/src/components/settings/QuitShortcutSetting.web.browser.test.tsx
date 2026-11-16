import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { QuitShortcutSetting } from "./QuitShortcutSetting";

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));

// Without the desktop host's bridge on window, there is no app to quit.
it("renders nothing in a browser tab", async () => {
  await using screen = await render(<QuitShortcutSetting />);

  expect(screen.getByText("Quit shortcut").elements()).toHaveLength(0);
});
