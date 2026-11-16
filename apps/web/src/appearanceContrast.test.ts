import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_APPEARANCE_CONTRAST,
  MIN_APPEARANCE_CONTRAST,
} from "@houston-app/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { formatAppearanceContrast } from "./appearanceContrast";

describe("formatAppearanceContrast", () => {
  it("labels the value the slider holds, not an offset from the default", () => {
    // The slider spans 50-200 with the default at 100, a third along the track. A label
    // of "0" at that thumb position disagrees with the track.
    expect(formatAppearanceContrast(DEFAULT_UNIFIED_SETTINGS.appearanceContrast)).toBe("100%");
    expect(formatAppearanceContrast(MIN_APPEARANCE_CONTRAST)).toBe("50%");
    expect(formatAppearanceContrast(MAX_APPEARANCE_CONTRAST)).toBe("200%");
  });
});
