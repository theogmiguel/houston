import { describe, expect, it } from "vite-plus/test";

import { layoutChromeInsets, MAC_TRAFFIC_LIGHTS_INSET } from "./layoutChrome";

describe("layoutChromeInsets", () => {
  it("clears the macOS traffic lights only for a pane at the window's leading edge on the desktop host", () => {
    expect(
      layoutChromeInsets({ mac: true, desktopHost: true, leadingEdge: true, trailingEdge: false }),
    ).toEqual({ leading: MAC_TRAFFIC_LIGHTS_INSET, trailing: undefined });
    expect(
      layoutChromeInsets({ mac: true, desktopHost: true, leadingEdge: false, trailingEdge: false }),
    ).toEqual({ leading: undefined, trailing: undefined });
    expect(
      layoutChromeInsets({ mac: true, desktopHost: false, leadingEdge: true, trailingEdge: false }),
    ).toEqual({ leading: undefined, trailing: undefined });
  });

  it("clears the native window controls at the trailing edge on other platforms", () => {
    expect(
      layoutChromeInsets({ mac: false, desktopHost: true, leadingEdge: true, trailingEdge: true }),
    ).toEqual({ leading: undefined, trailing: "var(--workspace-native-controls-inset)" });
  });

  it("adds nothing in a browser", () => {
    expect(
      layoutChromeInsets({ mac: false, desktopHost: false, leadingEdge: true, trailingEdge: true }),
    ).toEqual({ leading: undefined, trailing: undefined });
  });
});
