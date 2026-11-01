import { describe, expect, it } from "vite-plus/test";

import {
  SPLIT_CONTROL_CLASS,
  SPLIT_DIVIDER_CLASS,
  shortEffortLabel,
  traitsSplitTriggerClassName,
} from "./modelTraits";

describe("shortEffortLabel", () => {
  it("collapses the catalog labels to the segmented control's short forms", () => {
    expect(shortEffortLabel("Low")).toBe("Low");
    expect(shortEffortLabel("Medium")).toBe("Med");
    expect(shortEffortLabel("High")).toBe("High");
    expect(shortEffortLabel("Extra High")).toBe("Xhigh");
    expect(shortEffortLabel("xhigh")).toBe("Xhigh");
    expect(shortEffortLabel("Max")).toBe("Max");
  });

  it("shortens the extra-high label further on the compact row", () => {
    expect(shortEffortLabel("Extra High", true)).toBe("Xh");
    expect(shortEffortLabel("xhigh", true)).toBe("Xh");
    expect(shortEffortLabel("Medium", true)).toBe("Med");
    expect(shortEffortLabel("High", true)).toBe("High");
  });

  it("keeps an unknown label intact", () => {
    expect(shortEffortLabel("Ultracode")).toBe("Ultracode");
    expect(shortEffortLabel("Ultracode", true)).toBe("Ultracode");
  });
});

describe("traitsSplitTriggerClassName", () => {
  it("drops only the inner radius of each split half", () => {
    expect(traitsSplitTriggerClassName("start")).toBe("rounded-e-none");
    expect(traitsSplitTriggerClassName("end")).toBe("rounded-s-none");
    expect(traitsSplitTriggerClassName(undefined)).toBe("");
  });

  it("exposes the group and divider the footer wraps around the triggers", () => {
    expect(SPLIT_CONTROL_CLASS).toContain("inline-flex");
    expect(SPLIT_DIVIDER_CLASS).toContain("w-px");
  });
});
