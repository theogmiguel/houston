import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { StreamingGlyph } from "./TimelineRowParts";
import { TimelineRowActivityCtx, type TimelineRowActivityState } from "./timelineRowContext";
import { WorkingTimelineRow } from "./TimelineWorkGroupRows";

function runningInkColor(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--status-running-ink)";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

describe("StreamingGlyph", () => {
  it("draws a spinning ring of Running-ink dots instead of a filled mark", async () => {
    await using screen = await render(<StreamingGlyph />, { router: false });
    const glyph = screen.container.querySelector("[data-streaming-glyph]");
    const dots = [...screen.container.querySelectorAll("[data-streaming-dot]")];

    expect(glyph).not.toBeNull();
    expect(dots).toHaveLength(8);
    expect(getComputedStyle(glyph!).color).toBe(runningInkColor());
    expect(getComputedStyle(glyph!).animationName).not.toBe("none");
    for (const dot of dots) {
      expect(getComputedStyle(dot).fill).toBe(runningInkColor());
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

describe("WorkingTimelineRow", () => {
  it("shows the notice that opened the running turn on the working row", async () => {
    const activity = {
      isCompacting: false,
      isPreparingWorktree: false,
      backgroundWorktreeSetup: null,
      threadStatusPill: null,
    } as unknown as TimelineRowActivityState;
    await using screen = await render(
      <TimelineRowActivityCtx value={activity}>
        <WorkingTimelineRow
          row={{
            kind: "working",
            id: "working-indicator-row",
            createdAt: "2026-01-01T00:00:00.000Z",
            notice: {
              label: "resumed after restart",
              text: "Houston restarted and resumed this turn",
            },
          }}
        />
      </TimelineRowActivityCtx>,
      { router: false },
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Running");
    expect(text).toContain("resumed after restart");
    expect(text).toContain("Esc to interrupt");
  });
});
