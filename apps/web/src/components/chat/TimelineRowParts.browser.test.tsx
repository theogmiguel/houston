import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { StreamingGlyph } from "./TimelineRowParts";

function accentColor(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent-ink)";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

describe("StreamingGlyph", () => {
  it("draws a spinning ring of accent dots instead of a filled mark", async () => {
    await using screen = await render(<StreamingGlyph />, { router: false });
    const glyph = screen.container.querySelector("[data-streaming-glyph]");
    const dots = [...screen.container.querySelectorAll("[data-streaming-dot]")];

    expect(glyph).not.toBeNull();
    expect(dots).toHaveLength(8);
    expect(getComputedStyle(glyph!).color).toBe(accentColor());
    expect(getComputedStyle(glyph!).animationName).not.toBe("none");
    for (const dot of dots) {
      expect(getComputedStyle(dot).fill).toBe(accentColor());
    }
  });

  it("gives the sidebar working state the same dotted glyph", async () => {
    await using screen = await render(<SidebarStatusGlyph state="running" />, { router: false });

    expect(screen.container.querySelector('[role="img"][aria-label="Running"]')).not.toBeNull();
    expect(screen.container.querySelectorAll("[data-streaming-dot]")).toHaveLength(8);
  });

  it("keeps the other sidebar states as their own marks", async () => {
    await using screen = await render(<SidebarStatusGlyph state="ready" />, { router: false });

    expect(screen.container.querySelector("[data-streaming-glyph]")).toBeNull();
  });
});
