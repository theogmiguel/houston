import { describe, expect, it } from "vite-plus/test";

import { DIFF_VIEW_UNSAFE_CSS } from "./StyledDiffCodeView";

describe("DIFF_VIEW_UNSAFE_CSS", () => {
  // Composed fixture: the real viewer renders in a shadow root, so this pins the stylesheet text
  // that overrides the library's transparent-at-rest scrollbar thumb.
  it("keeps the horizontal scrollbar thumb of non-wrapping diffs visible at rest", () => {
    const rule = DIFF_VIEW_UNSAFE_CSS.match(
      /\[data-overflow="scroll"\] \[data-code\]::-webkit-scrollbar-thumb \{([^}]*)\}/,
    );
    expect(rule, "no at-rest scrollbar thumb rule for [data-overflow=scroll]").not.toBeNull();
    expect(rule![1]).toMatch(/background-color:\s*color-mix\([^;]*\)\s*!important/);
  });
});
