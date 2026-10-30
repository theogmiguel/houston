import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeHeader } from "./SidebarChrome";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => null) as never,
}));

describe("SidebarChromeHeader", () => {
  it("draws the board's brand row: an 18px mark, Houston and the hide button", async () => {
    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarChromeHeader isElectron={false} />
      </SidebarProvider>,
    );

    const mark = screen.container.querySelector("img");
    expect(mark).not.toBeNull();
    const style = getComputedStyle(mark as HTMLImageElement);
    expect(style.width).toBe("18px");
    expect(style.height).toBe("18px");

    await expect.element(screen.getByText("Houston")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    expect(screen.container.querySelector("[data-stage-art]")).toBeNull();
  });
});
