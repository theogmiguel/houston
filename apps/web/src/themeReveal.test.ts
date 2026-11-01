import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { revealThemeFromClick, themeRevealRadius } from "./themeReveal";

const origin = { left: 12, top: 20, width: 16, height: 12 };
const controlRect = { ...origin, right: 28, bottom: 32, x: 12, y: 20, toJSON: () => ({}) };

function control() {
  return {
    getBoundingClientRect: () => controlRect,
  } as unknown as Element;
}

function stubViewport({ reducedMotion = false, matchMedia = true } = {}) {
  vi.stubGlobal("window", {
    innerWidth: 100,
    innerHeight: 80,
    ...(matchMedia ? { matchMedia: () => ({ matches: reducedMotion }) } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme reveal", () => {
  it("computes a radius that reaches the farthest viewport corner", () => {
    expect(themeRevealRadius(origin, { width: 100, height: 80 })).toBe(97);
  });

  it("uses one 400 ms Panel-eased WAAPI clip on the new View Transition snapshot", async () => {
    const update = vi.fn();
    const animate = vi.fn((_keyframes: unknown, _options: unknown) => ({
      finished: Promise.resolve(),
    }));
    const root = { dataset: {} as Record<string, string | undefined>, animate };
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { ready: Promise.resolve() };
    });
    vi.stubGlobal("document", { documentElement: root, startViewTransition });
    stubViewport();
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: () => "cubic-bezier(.32, .72, 0, 1)",
    }));

    revealThemeFromClick(control(), update);

    await vi.waitFor(() => expect(animate).toHaveBeenCalled());
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]![0]).toEqual([
      { clipPath: "circle(0px at 20px 26px)" },
      { clipPath: "circle(97px at 20px 26px)" },
    ]);
    expect(animate.mock.calls[0]![1]).toMatchObject({
      duration: 400,
      easing: "cubic-bezier(.32, .72, 0, 1)",
      pseudoElement: "::view-transition-new(root)",
    });
  });

  it("reveals from a viewport point origin", async () => {
    const animate = vi.fn((_keyframes: unknown, _options: unknown) => ({
      finished: Promise.resolve(),
    }));
    const root = { dataset: {} as Record<string, string | undefined>, animate };
    vi.stubGlobal("document", {
      documentElement: root,
      startViewTransition: (callback: () => void) => {
        callback();
        return { ready: Promise.resolve() };
      },
    });
    stubViewport();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));

    revealThemeFromClick({ left: 50, top: 40, width: 0, height: 0 }, vi.fn());

    await vi.waitFor(() => expect(animate).toHaveBeenCalled());
    expect(animate.mock.calls[0]![0]).toEqual([
      { clipPath: "circle(0px at 50px 40px)" },
      { clipPath: "circle(65px at 50px 40px)" },
    ]);
  });

  it("scopes the reveal rules for the transition only", async () => {
    const root = { dataset: {} as Record<string, string | undefined>, animate: vi.fn() };
    let scoped: string | undefined;
    vi.stubGlobal("document", {
      documentElement: root,
      startViewTransition: (callback: () => void) => {
        scoped = root.dataset.themeReveal;
        callback();
        return { ready: Promise.resolve() };
      },
    });
    stubViewport();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));

    revealThemeFromClick(control(), vi.fn());

    expect(scoped).toBe("true");
    await vi.waitFor(() => expect(root.dataset.themeReveal).toBeUndefined());
  });

  it.each([
    ["reduced motion", true, true],
    ["missing View Transition support", false, false],
  ])("%s switches in one step", (_case, reduced, supported) => {
    const update = vi.fn();
    const startViewTransition = vi.fn(() => ({ ready: Promise.resolve() }));
    stubViewport({ reducedMotion: reduced });
    vi.stubGlobal("document", {
      documentElement: { dataset: {}, animate: vi.fn() },
      startViewTransition: supported ? startViewTransition : undefined,
    });

    revealThemeFromClick(control(), update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("switches programmatic theme changes without animation", () => {
    const update = vi.fn();
    const startViewTransition = vi.fn();
    vi.stubGlobal("document", {
      documentElement: { dataset: {}, animate: vi.fn() },
      startViewTransition,
    });

    revealThemeFromClick(null, update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("switches in one step when matchMedia is unavailable", () => {
    const update = vi.fn();
    const startViewTransition = vi.fn();
    stubViewport({ matchMedia: false });
    vi.stubGlobal("document", {
      documentElement: { dataset: {}, animate: vi.fn() },
      startViewTransition: undefined,
    });

    revealThemeFromClick(control(), update);

    expect(update).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});
