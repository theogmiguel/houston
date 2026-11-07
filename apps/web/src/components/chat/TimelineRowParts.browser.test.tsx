import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarStatusGlyph } from "../sidebar/SidebarStatusGlyph";
import { RestartNoteTrigger, StreamingGlyph } from "./TimelineRowParts";
import { TooltipProvider } from "../ui/tooltip";
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
              restarts: [
                { at: "2026-01-01T00:00:00.000Z", text: "Houston restarted and resumed this turn" },
              ],
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

async function renderLongRunningRow(width: number) {
  const activity = {
    isCompacting: false,
    isPreparingWorktree: false,
    backgroundWorktreeSetup: null,
    threadStatusPill: null,
  } as unknown as TimelineRowActivityState;
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return render(
    <TooltipProvider delay={0}>
      <TimelineRowActivityCtx value={activity}>
        <WorkingTimelineRow
          row={{
            kind: "working",
            id: "working-indicator-row",
            // A fixed epoch long past: the timer reads in days, longer than the 24h 59m of the capture.
            createdAt: "2026-01-01T00:00:00.000Z",
            notice: {
              label: "resumed after restart",
              text: "Houston restarted and resumed this turn",
              restarts: [
                { at: "2026-01-01T00:00:00.000Z", text: "Houston restarted and resumed this turn" },
              ],
            },
          }}
        />
      </TimelineRowActivityCtx>
    </TooltipProvider>,
    { router: false, container },
  );
}

describe("WorkingTimelineRow in a narrow pane", () => {
  it("drops the interrupt hint first at a 370px pane, keeping it in the tooltip and accessible text", async () => {
    await using screen = await renderLongRunningRow(370);
    const row = screen.container.querySelector<HTMLElement>("[data-working-row]")!;
    const hint = [...row.querySelectorAll<HTMLElement>("span")].find(
      (node) =>
        node.textContent?.trim().endsWith("Esc to interrupt") === true &&
        node.children.length <= 1 &&
        node.matches(".shrink-0"),
    )!;
    expect(hint.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(row.textContent).toContain("Running");
    await userEvent.hover(row);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
        "Esc to interrupt",
      ),
    );
  });

  it("shows the interrupt hint when the pane is wide", async () => {
    await using screen = await renderLongRunningRow(640);
    const hint = [...screen.container.querySelectorAll<HTMLElement>("span")].find(
      (node) =>
        node.textContent?.trim().endsWith("Esc to interrupt") === true &&
        node.children.length <= 1 &&
        node.matches(".shrink-0"),
    )!;
    expect(hint.getBoundingClientRect().width).toBeGreaterThan(40);
  });
});

describe("RestartNoteTrigger", () => {
  it("lists every restart with its time in a tooltip", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <RestartNoteTrigger
          note={{
            label: "resumed after restart",
            restarts: [
              { at: "2026-01-01T09:15:00.000Z", text: "Houston restarted and resumed this turn" },
              { at: "2026-01-01T11:40:00.000Z", text: "Houston restarted and resumed this turn" },
            ],
          }}
        />
      </TooltipProvider>,
      { router: false },
    );
    const trigger = screen.container.querySelector<HTMLElement>("[data-restart-note]")!;
    expect(trigger.textContent).toBe("· resumed after restart");

    await userEvent.hover(trigger);
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-restart-time]")).toHaveLength(2),
    );
    const popup = document.querySelector('[data-slot="tooltip-popup"]')!;
    expect(popup.textContent).toContain("Restarted 2 times");
  });
});
