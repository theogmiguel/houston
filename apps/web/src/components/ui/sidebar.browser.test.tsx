import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./sidebar";

function CollapseFromInside() {
  const { setOpen } = useSidebar();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      Collapse
    </button>
  );
}

function Harness(props: { readonly onResize?: (width: number) => void }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        collapsible="offcanvas"
        resizable={{
          minWidth: 200,
          maxWidth: 600,
          ...(props.onResize ? { onResize: props.onResize } : {}),
        }}
      >
        <CollapseFromInside />
        <SidebarRail />
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

const resolveColor = (value: string) => {
  const probe = document.createElement("span");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
};

describe("Sidebar", () => {
  it("hands focus to the outside trigger when it collapses around the focused control", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness />, { router: false /* no routes involved */ });

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));

    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    await vi.waitFor(() => expect(sidebar.inert).toBe(true));
    const trigger = screen.container.querySelector('[data-slot="sidebar-trigger"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("separates the canvas from the sidebar with one divider, not an inset card", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(
      <SidebarProvider defaultOpen className="h-dvh! min-h-0!">
        <Sidebar collapsible="offcanvas" data-app-sidebar="">
          <SidebarContent>Project</SidebarContent>
        </Sidebar>
        <SidebarInset>Canvas</SidebarInset>
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );

    const inset = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
    const insetStyle = getComputedStyle(inset);
    expect(insetStyle.marginTop).toBe("0px");
    expect(insetStyle.marginLeft).toBe("0px");
    expect(insetStyle.borderTopWidth).toBe("0px");
    expect(insetStyle.borderTopLeftRadius).toBe("0px");
    expect(insetStyle.backgroundColor).toBe(resolveColor("var(--content)"));

    const container = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    )!;
    const containerStyle = getComputedStyle(container);
    expect(containerStyle.borderRightWidth).toBe("1px");
    expect(containerStyle.borderRightColor).toBe(resolveColor("var(--divider)"));
  });

  it("fades scrolled content over a whole row at its edges, and not once the list is scrolled clear", async () => {
    await page.viewport(1280, 400);
    await using screen = await render(
      <SidebarProvider defaultOpen className="h-dvh! min-h-0!">
        <Sidebar collapsible="offcanvas">
          <SidebarContent>
            {Array.from({ length: 40 }, (_, index) => (
              <div key={index} className="h-9 shrink-0">
                Row {index}
              </div>
            ))}
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );

    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!;
    expect(getComputedStyle(viewport).getPropertyValue("--fade-size")).toBe("1.5rem");
    // The fade is driven by the viewport's measured overflow, not by a scroll-state query, so it is
    // present in every Chromium: the bottom layer dissolves the last 24px while content remains below.
    await vi.waitFor(() =>
      expect(getComputedStyle(viewport).maskImage).toContain(
        "linear-gradient(rgb(0, 0, 0) calc(100% - 24px), rgba(0, 0, 0, 0) 100%)",
      ),
    );

    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() =>
      expect(viewport.style.getPropertyValue("--scroll-area-overflow-y-end")).toBe("0px"),
    );
    expect(getComputedStyle(viewport).maskImage).not.toContain(
      "linear-gradient(rgb(0, 0, 0) calc(100% - 24px), rgba(0, 0, 0, 0) 100%)",
    );
  });

  it("abandons a rail drag when the sidebar collapses mid-drag", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const { left, top } = rail.getBoundingClientRect();
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: top + 10 };
    const dragTo = (clientX: number) => {
      rail.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: left }));
      rail.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
    };
    // A completed drag commits, so the abandoned one below is a real drag too.
    dragTo(left + 40);
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 40 }));
    expect(onResize).toHaveBeenCalledTimes(1);

    dragTo(left + 80);
    await userEvent.click(
      screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
    );
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 80 }));

    expect(onResize).toHaveBeenCalledTimes(1);
  });

  describe("below the dock breakpoint", () => {
    function docked(screen: { container: HTMLElement }) {
      return screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]');
    }

    it("turns the rail into a closed drawer that the toggle opens", async () => {
      await page.viewport(900, 800);
      await using screen = await render(<Harness />, { router: false /* no routes involved */ });

      expect(docked(screen)).toBeNull();
      expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();

      await userEvent.click(
        screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
      );

      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).not.toBeNull(),
      );
    });

    it("caps the drawer at 320px over a scrim even when its content is wider", async () => {
      await page.viewport(800, 900);
      await using screen = await render(
        <SidebarProvider defaultOpen>
          <Sidebar collapsible="offcanvas" resizable>
            <div style={{ width: 760, flexShrink: 0 }}>A row with a very long thread title</div>
          </Sidebar>
          <SidebarTrigger />
        </SidebarProvider>,
        { router: false /* no routes involved */ },
      );
      await userEvent.click(
        screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
      );
      const drawer = await vi.waitFor(() => {
        const element = document.querySelector<HTMLElement>(
          '[data-slot="sidebar"][data-mobile="true"]',
        );
        expect(element).not.toBeNull();
        return element!;
      });
      expect(drawer.getBoundingClientRect().width).toBe(320);
      expect(document.querySelector('[data-slot="sheet-backdrop"]')).not.toBeNull();
    });

    it.each(["light", "dark"] as const)(
      "dims the page behind the drawer with a visible scrim in the %s theme",
      async (theme) => {
        await page.viewport(800, 900);
        document.documentElement.classList.toggle("dark", theme === "dark");
        await using _theme = {
          [Symbol.asyncDispose]: async () => document.documentElement.classList.remove("dark"),
        };
        await using screen = await render(
          <SidebarProvider defaultOpen>
            <Sidebar collapsible="offcanvas" resizable>
              <div>Threads</div>
            </Sidebar>
            <SidebarTrigger />
          </SidebarProvider>,
          { router: false /* no routes involved */ },
        );
        await userEvent.click(
          screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
        );
        const backdrop = await vi.waitFor(() => {
          const element = document.querySelector<HTMLElement>('[data-slot="sheet-backdrop"]');
          expect(element).not.toBeNull();
          return element!;
        });
        // The backdrop fades in, so wait until it has its full opacity.
        await vi.waitFor(() => expect(getComputedStyle(backdrop).opacity).toBe("1"));
        // A film in the canvas colour is invisible on the canvas: the scrim is black, and not faint.
        // The computed colour may be in oklab, so a canvas converts it to sRGB.
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.fillStyle = getComputedStyle(backdrop).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const [red = 255, green = 255, blue = 255, alpha255 = 255] = context.getImageData(
          0,
          0,
          1,
          1,
        ).data;
        const alpha = alpha255 / 255;
        expect(Math.max(red, green, blue)).toBeLessThanOrEqual(8);
        expect(alpha).toBeGreaterThanOrEqual(0.3);
      },
    );

    it("keeps the rail docked from 960px up", async () => {
      await page.viewport(960, 800);
      await using screen = await render(<Harness />, { router: false /* no routes involved */ });

      expect(docked(screen)).not.toBeNull();
      expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
    });

    it("docks the rail again when the window widens, keeping a manual collapse", async () => {
      await page.viewport(1280, 800);
      await using screen = await render(<Harness />, { router: false /* no routes involved */ });
      await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
      await vi.waitFor(() => expect(docked(screen)?.inert).toBe(true));

      await page.viewport(900, 800);
      await vi.waitFor(() => expect(docked(screen)).toBeNull());
      await page.viewport(1280, 800);

      await vi.waitFor(() => expect(docked(screen)).not.toBeNull());
      expect(docked(screen)!.inert).toBe(true);
    });

    it("returns to an expanded docked rail, not an open drawer, after widening", async () => {
      await page.viewport(900, 800);
      await using screen = await render(<Harness />, { router: false /* no routes involved */ });
      await userEvent.click(
        screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).not.toBeNull(),
      );

      await page.viewport(1280, 800);

      await vi.waitFor(() => expect(docked(screen)).not.toBeNull());
      expect(docked(screen)!.inert).toBe(false);
      await page.viewport(900, 800);
      await vi.waitFor(() => expect(docked(screen)).toBeNull());
      expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
    });
  });
});
