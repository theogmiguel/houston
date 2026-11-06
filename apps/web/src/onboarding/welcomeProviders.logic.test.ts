import { describe, expect, it } from "vite-plus/test";

import { formatProvidersToSet, formatReadyProviders } from "./welcomeProviders.logic";

describe("formatReadyProviders", () => {
  it("collapses ready providers into one sentence", () => {
    expect(formatReadyProviders([])).toBeNull();
    expect(formatReadyProviders(["Claude Code"])).toBe("Claude Code ready");
    expect(formatReadyProviders(["Claude Code", "Codex"])).toBe("Claude Code and Codex ready");
    expect(formatReadyProviders(["Claude Code", "Codex", "Cursor"])).toBe(
      "Claude Code, Codex and Cursor ready",
    );
  });
});

describe("formatProvidersToSet", () => {
  it("counts the providers behind the disclosure", () => {
    expect(formatProvidersToSet({ pending: 3, ready: 2 })).toBe("3 more providers to set up");
    expect(formatProvidersToSet({ pending: 1, ready: 1 })).toBe("1 more provider to set up");
    expect(formatProvidersToSet({ pending: 2, ready: 0 })).toBe("2 providers to set up");
  });
});
