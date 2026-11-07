import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DiffFileLoadingBoundary } from "./DiffFileLoadingBoundary";

function stubIntersectionObserver() {
  let observeCount = 0;
  // Like the real observer, every observe() reports the target's current state; this boundary
  // is always in range.
  class InRangeIntersectionObserver {
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      observeCount += 1;
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", InRangeIntersectionObserver);
  return {
    get observeCount() {
      return observeCount;
    },
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

describe("DiffFileLoadingBoundary", () => {
  it("observes once and loads once while its parent re-renders with a new load", async () => {
    using observer = stubIntersectionObserver();
    const load = vi.fn();
    // DiffPanel hands over a new loadNextFiles whenever any file patch changes.
    await using screen = await render(
      <DiffFileLoadingBoundary load={() => load()} count={8} loading />,
      {
        router: false, // the boundary does not touch routing
      },
    );
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} loading />);
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} loading />);
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={8} loading />);

    await expect.element(screen.getByRole("status", { name: "Loading diff…" })).toBeInTheDocument();
    expect(observer.observeCount).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    // A settled batch leaves the boundary in range, so it asks for the next one.
    await screen.rerender(<DiffFileLoadingBoundary load={() => load()} count={4} loading />);
    expect(observer.observeCount).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("draws no placeholder headers once nothing is loading, though files remain", async () => {
    using observer = stubIntersectionObserver();
    await using screen = await render(
      <DiffFileLoadingBoundary load={() => {}} count={3} loading={false} />,
      { router: false },
    );
    expect(observer.observeCount).toBe(1);
    expect(screen.container.querySelector("[role=status]")).toBeNull();
    expect(screen.container.querySelectorAll("[aria-hidden]")).toHaveLength(0);
  });

  it("draws no skeleton file rows while the next batch loads under a rendered diff", async () => {
    using observer = stubIntersectionObserver();
    await using screen = await render(
      <DiffFileLoadingBoundary load={() => {}} count={5} loading />,
      { router: false },
    );
    // The status stays announced, but a fully rendered diff gets no second skeleton file.
    expect(observer.observeCount).toBe(1);
    expect(screen.container.querySelector("[role=status]")).not.toBeNull();
    expect(screen.container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });
});
