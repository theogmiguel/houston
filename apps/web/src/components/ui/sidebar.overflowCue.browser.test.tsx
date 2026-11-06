import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarContent } from "./sidebar";

function cueOpacity(container: HTMLElement): number {
  const root = container.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!
    .parentElement!;
  return Number(getComputedStyle(root, "::after").opacity);
}

describe("SidebarContent overflow cue", () => {
  it("shows a chevron over the bottom edge while rows continue below it, and not at the end", async () => {
    await using screen = await render(
      <div style={{ height: 200 }} className="flex flex-col">
        <SidebarContent>
          <div style={{ height: 600 }}>rows</div>
        </SidebarContent>
      </div>,
    );
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    await expect.poll(() => cueOpacity(screen.container)).toBe(1);

    viewport.scrollTop = viewport.scrollHeight;
    await expect.poll(() => cueOpacity(screen.container)).toBe(0);
  });

  it("shows no chevron when the rows fit", async () => {
    await using screen = await render(
      <div style={{ height: 200 }} className="flex flex-col">
        <SidebarContent>
          <div style={{ height: 80 }}>rows</div>
        </SidebarContent>
      </div>,
    );
    await expect.poll(() => cueOpacity(screen.container)).toBe(0);
  });
});
