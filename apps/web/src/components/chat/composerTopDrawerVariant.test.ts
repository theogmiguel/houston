import { describe, expect, it } from "vite-plus/test";

import { composerTopDrawerVariant } from "./composerTopDrawerVariant";

describe("composerTopDrawerVariant", () => {
  it("keeps the warning tint for a pending question", () => {
    expect(composerTopDrawerVariant({ hasPendingUserInput: true })).toBe("warning");
  });

  it("leaves a finished plan's drawer neutral", () => {
    expect(composerTopDrawerVariant({ hasPendingUserInput: false })).toBe("default");
  });
});
