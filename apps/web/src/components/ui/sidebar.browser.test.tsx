import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";

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
        expect(
          document.querySelector('[data-slot="sidebar"][data-mobile="true"]'),
        ).not.toBeNull(),
      );
    });

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
        expect(
          document.querySelector('[data-slot="sidebar"][data-mobile="true"]'),
        ).not.toBeNull(),
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
