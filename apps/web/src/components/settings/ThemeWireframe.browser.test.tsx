import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ThemeWireframe } from "./ThemeWireframe";
import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

const lightColors: ThemeCardPreviewColors = {
  canvas: "#ffffff",
  sidebar: "#f6f6f7",
  surface: "#ffffff",
  accentSurface: "#ececf0",
  messageSurface: "#f2f2f4",
  messageAction: "#5b5bd6",
} as ThemeCardPreviewColors;

describe("ThemeWireframe", () => {
  it("outlines and lifts a light preview so it separates from a light page", async () => {
    await using screen = await render(
      <div style={{ background: "#ffffff", padding: 16, width: 240 }}>
        <ThemeWireframe className="h-20" panes={[{ colors: lightColors }]} />
      </div>,
    );

    const card = screen.container.querySelector<HTMLElement>("span[aria-hidden]")!;
    const style = getComputedStyle(card);
    expect(style.borderTopWidth).toBe("1px");
    // The default hairline is about 9% ink and vanishes on white.
    const alpha = Number(/\/ ([\d.]+)\)/.exec(style.borderTopColor)?.[1] ?? 1);
    expect(alpha).toBeGreaterThanOrEqual(0.15);
    expect(style.boxShadow).not.toBe("none");
  });
});
