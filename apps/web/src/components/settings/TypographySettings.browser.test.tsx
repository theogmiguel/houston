import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { TypographySection } from "./TypographySettings";

const state = vi.hoisted(() => ({ searchTargetId: null as string | null }));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));
// The previews mount Ghostty and Shiki, which this test does not exercise.
vi.mock(import("./SettingsFontPreviews"), () => ({
  CodeFontPreview: () => <div />,
  PromptFontPreview: () => <div />,
  TerminalFontPreview: () => <div />,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
}));

function setup(searchTargetId: string | null) {
  state.searchTargetId = searchTargetId;
  removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY);
  return { [Symbol.dispose]: () => removeLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY) };
}

describe("TypographySection", () => {
  it("persists the advanced flag the terminal reads when a deep link targets an advanced row", async () => {
    using _storage = setup("terminal-font");
    await using screen = await render(<TypographySection />);

    await expect.element(screen.getByRole("heading", { name: "Terminal font" })).toBeVisible();
    expect(getLocalStorageItem(TYPOGRAPHY_ADVANCED_STORAGE_KEY, Schema.Boolean)).toBe(true);
  });

  it.each([
    ["MacIntel", true],
    ["Linux x86_64", false],
    ["Win32", false],
  ])("shows the macOS-only font smoothing row on %s: %s", async (platform, visible) => {
    using _storage = setup(null);
    const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    try {
      await using screen = await render(<TypographySection />);

      await expect.element(screen.getByText("Separate fonts")).toBeVisible();
      expect(screen.getByText("Font smoothing").elements().length).toBe(visible ? 1 : 0);
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the default family at full ink so an empty font field does not read as disabled", async () => {
    using _storage = setup(null);
    await using screen = await render(<TypographySection />);

    const field = screen.getByRole("textbox", { name: "Interface font family" });
    await expect.element(field).toBeVisible();
    const input = field.element() as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder.length).toBeGreaterThan(0);
    const placeholder = getComputedStyle(input, "::placeholder").color;
    expect(placeholder).toBe(getComputedStyle(input).color);
  });
});
