import { describe, expect, it } from "vite-plus/test";

import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { layoutChromeInsets, NATIVE_CONTROLS_INSET } from "./layoutChrome";

describe("layoutChromeInsets", () => {
  it("clears the collapsed-sidebar toggle and the traffic lights at the window's leading edge, on every platform", () => {
    expect(layoutChromeInsets({ leadingEdge: true, trailingEdge: false })).toEqual({
      leadingClassName: COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      trailing: undefined,
    });
  });

  it("clears the native window controls at the trailing edge", () => {
    expect(layoutChromeInsets({ leadingEdge: false, trailingEdge: true })).toEqual({
      leadingClassName: undefined,
      trailing: NATIVE_CONTROLS_INSET,
    });
  });

  it("adds nothing in the middle of the strip", () => {
    expect(layoutChromeInsets({ leadingEdge: false, trailingEdge: false })).toEqual({
      leadingClassName: undefined,
      trailing: undefined,
    });
  });

  it("clears both ends of a lone pane", () => {
    const both = layoutChromeInsets({ leadingEdge: true, trailingEdge: true });
    expect(both.leadingClassName).toBe(COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS);
    expect(both.trailing).toBe("var(--workspace-native-controls-inset)");
  });
});
