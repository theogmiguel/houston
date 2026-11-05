import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIdentificationDisplay,
  resolveEnvironmentIdentificationPillLabel,
} from "./environmentIdentification";

describe("resolveEnvironmentIdentificationDisplay", () => {
  it.each(["pill", "artwork", "nightly-artwork", "dev-artwork"] as const)(
    "shows the pill for the stored mode %s",
    (mode) => {
      expect(resolveEnvironmentIdentificationDisplay(mode, true)).toBe("pill");
    },
  );

  it("shows nothing for none", () => {
    expect(resolveEnvironmentIdentificationDisplay("none", true)).toBe("none");
  });

  it("shows nothing until settings are hydrated", () => {
    expect(resolveEnvironmentIdentificationDisplay("pill", false)).toBe("none");
  });
});

describe("resolveEnvironmentIdentificationPillLabel", () => {
  it.each([
    ["Dev", "Dev"],
    [" nightly ", "Nightly"],
    ["Latest", null],
  ])("labels the %j stage as %j", (stage, label) => {
    expect(resolveEnvironmentIdentificationPillLabel(stage)).toBe(label);
  });
});
