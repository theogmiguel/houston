import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { setAppearanceMode } from "../../hooks/useTheme";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarUtilityMenu } from "./SidebarChrome";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => null) as never,
}));

const APPEARANCE_MODE_KEY = "t3code:theme-appearance-mode";

afterEach(() => {
  delete document.documentElement.dataset.themeReveal;
  Reflect.deleteProperty(document, "startViewTransition");
  window.localStorage.removeItem(APPEARANCE_MODE_KEY);
  vi.restoreAllMocks();
});

describe("sidebar theme button", () => {
  it("reveals the next appearance from the centre of the button", async () => {
    setAppearanceMode("dark");
    let scopedForTransition: string | undefined;
    const startViewTransition = vi.fn((update: () => void) => {
      scopedForTransition = document.documentElement.dataset.themeReveal;
      update();
      return { ready: Promise.resolve() };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });
    const animate = vi
      .spyOn(document.documentElement, "animate")
      .mockReturnValue({ finished: Promise.resolve() } as unknown as Animation);

    await using screen = await render(
      <SidebarProvider defaultOpen>
        <SidebarUtilityMenu />
      </SidebarProvider>,
    );
    const button = screen.getByRole("button", { name: "Theme: Graphite" });
    const rect = button.element().getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    await userEvent.click(button);

    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(scopedForTransition).toBe("true");
    const [keyframes, options] = animate.mock.calls[0]!;
    expect(keyframes).toEqual([
      { clipPath: `circle(0px at ${centerX}px ${centerY}px)` },
      expect.objectContaining({ clipPath: expect.stringMatching(/^circle\(\d+px at /) }),
    ]);
    expect((keyframes as Array<{ clipPath: string }>)[1]!.clipPath).toBe(
      `circle(${Math.ceil(
        Math.hypot(
          Math.max(centerX, window.innerWidth - centerX),
          Math.max(centerY, window.innerHeight - centerY),
        ),
      )}px at ${centerX}px ${centerY}px)`,
    );
    expect(options).toMatchObject({
      duration: 400,
      pseudoElement: "::view-transition-new(root)",
    });
    await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(false);
  });
});
