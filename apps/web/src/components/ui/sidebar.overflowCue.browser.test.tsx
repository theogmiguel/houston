import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarContent } from "./sidebar";

function viewportOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
}

function bottomFadePx(viewport: HTMLElement): number {
  return Number.parseFloat(
    getComputedStyle(viewport).getPropertyValue("--scroll-area-overflow-y-end"),
  );
}

describe("SidebarContent overflow cue", () => {
  it("fades the bottom 24px while rows continue below it, with no chevron, and not at the end", async () => {
    await using screen = await render(
      <div style={{ height: 200 }} className="flex flex-col">
        <SidebarContent>
          <div style={{ height: 600 }}>rows</div>
        </SidebarContent>
      </div>,
    );
    const viewport = viewportOf(screen.container);
    expect(getComputedStyle(viewport.parentElement!, "::after").content).toBe("none");
    expect(Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--fade-size"))).toBe(1.5);
    expect(getComputedStyle(viewport).getPropertyValue("--fade-size").trim()).toBe("1.5rem");
    await expect.poll(() => bottomFadePx(viewport)).toBeGreaterThan(0);
    expect(getComputedStyle(viewport).maskImage).not.toBe("none");

    viewport.scrollTop = viewport.scrollHeight;
    await expect.poll(() => bottomFadePx(viewport)).toBe(0);
  });

  it("shows no fade when the rows fit", async () => {
    await using screen = await render(
      <div style={{ height: 200 }} className="flex flex-col">
        <SidebarContent>
          <div style={{ height: 80 }}>rows</div>
        </SidebarContent>
      </div>,
    );
    await expect.poll(() => bottomFadePx(viewportOf(screen.container))).toBe(0);
  });
});
