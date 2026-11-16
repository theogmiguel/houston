import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadStatusKindGlyph, type ThreadStatusKind } from "./thread-state-glyph";

const KINDS: ReadonlyArray<ThreadStatusKind> = [
  "ready",
  "running",
  "waiting",
  "goal",
  "approval",
  "input",
  "request",
  "needs",
  "limited",
  "failed",
  "back",
  "idle",
  "closed",
];

describe("thread status glyphs", () => {
  it("draws one distinct 14px shape per status kind", async () => {
    await using screen = await render(
      <div>
        {KINDS.map((kind) => (
          <ThreadStatusKindGlyph key={kind} kind={kind} />
        ))}
      </div>,
    );

    const shapes = KINDS.map((kind) => {
      const glyph = screen.container.querySelector<SVGElement>(`[data-status-kind="${kind}"]`);
      expect(glyph).not.toBeNull();
      expect(glyph!.getBoundingClientRect().width).toBe(14);
      return kind === "running"
        ? `running:${glyph!.querySelectorAll("[data-streaming-dot]").length}`
        : glyph!.innerHTML;
    });
    // Every kind is its own shape, so a state reads the same wherever it is drawn.
    expect(new Set(shapes).size).toBe(KINDS.length);
    expect(shapes[1]).toBe("running:8");
  });

  it("paints each kind with its status ink", async () => {
    await using screen = await render(
      <div>
        {KINDS.map((kind) => (
          <ThreadStatusKindGlyph key={kind} kind={kind} className="text-current" />
        ))}
      </div>,
    );
    // The ink comes from the caller; the glyph itself only draws with currentColor.
    const failed = screen.container.querySelector<SVGElement>('[data-status-kind="failed"]')!;
    expect(failed.getAttribute("stroke")).toBe("currentColor");
    expect(failed.getAttribute("stroke-width")).toBe("2");
    expect(failed.getAttribute("stroke-linecap")).toBe("round");
  });
});
