import { describe, expect, it } from "vite-plus/test";

import { usageRemainingFill, usageRemainingTone } from "./usageRemaining";

describe("plan-limit meter tones", () => {
  it("keeps a live window neutral and turns the number to full contrast below 20%", () => {
    expect(usageRemainingTone(100)).toBe("normal");
    expect(usageRemainingTone(20)).toBe("normal");
    expect(usageRemainingTone(19.9)).toBe("low");
    expect(usageRemainingTone(1)).toBe("low");
  });

  it("reserves the stop colour for a fully exhausted window", () => {
    expect(usageRemainingTone(0)).toBe("empty");
    expect(usageRemainingTone(-3)).toBe("empty");
    expect(usageRemainingFill(0)).toBe("var(--stop)");
  });

  it("fills every live bar with t2, never amber", () => {
    expect(usageRemainingFill(80)).toBe("var(--secondary-foreground)");
    expect(usageRemainingFill(19)).toBe("var(--secondary-foreground)");
  });
});
