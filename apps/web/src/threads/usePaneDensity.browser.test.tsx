import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { usePaneDensity } from "./usePaneDensity";

function Probe({ onCommit }: { onCommit: (density: string) => void }) {
  const { ref, density } = usePaneDensity(2);
  useEffect(() => {
    onCommit(density);
  });
  return (
    <div
      ref={(element) => {
        ref.current = element;
      }}
      data-grid-cell=""
      data-testid="pane"
      style={{ width: 300, height: 600 }}
    />
  );
}

function pane(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-testid=pane]")!;
}

function CountedProbe({
  threadCount,
  onRender,
}: {
  threadCount: number;
  onRender: (density: string) => void;
}) {
  const { ref, density } = usePaneDensity(threadCount);
  onRender(density);
  return (
    <div
      ref={(element) => {
        ref.current = element;
      }}
      data-grid-cell=""
      data-testid="pane"
      style={{ width: 1000, height: 600 }}
    />
  );
}

describe("usePaneDensity", () => {
  it("re-tiers a pane whose grid changes size in the same render, not a second one", async () => {
    const renders: string[] = [];
    const view = (threadCount: number) => (
      <CountedProbe threadCount={threadCount} onRender={(density) => renders.push(density)} />
    );
    await using screen = await render(view(2));
    await vi.waitFor(() => expect(renders.at(-1)).toBe("comfortable"));
    const before = renders.length;
    await screen.rerender(view(1));
    // A maximize changes the pane's thread count; re-rendering its whole chat twice is the delay.
    expect(renders.slice(before)).toEqual(["solo"]);
  });

  it("re-tiers after a resize settles", async () => {
    const commits: string[] = [];
    await using screen = await render(<Probe onCommit={(density) => commits.push(density)} />);
    expect(commits.at(-1)).toBe("glance");
    pane(screen.container).style.width = "700px";
    await vi.waitFor(() => expect(commits.at(-1)).toBe("comfortable"));
  });

  it("waits for the cell's own motion to end before re-rendering", async () => {
    using _timers = fakeTimers();
    const commits: string[] = [];
    await using screen = await render(<Probe onCommit={(density) => commits.push(density)} />);
    const cell = pane(screen.container);
    const motion = cell.animate(
      [{ transform: "translate(100px, 0)" }, { transform: "translate(0, 0)" }],
      { duration: 60_000 },
    );
    const before = commits.length;
    cell.style.width = "700px";
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await act(() => vi.runOnlyPendingTimers());
    // Past the settle delay but mid-motion: re-rendering the chat now drops frames.
    expect(commits.length).toBe(before);
    motion.finish();
    await vi.waitFor(() => expect(commits.at(-1)).toBe("comfortable"));
  });

  it("waits for a neighbouring cell's move when it resizes in place", async () => {
    using _timers = fakeTimers();
    const commits: string[] = [];
    await using screen = await render(
      <div data-grid-surface="">
        <Probe onCommit={(density) => commits.push(density)} />
        <div data-grid-cell="" data-testid="neighbour" style={{ width: 100, height: 100 }} />
      </div>,
    );
    const neighbour = screen.container.querySelector<HTMLElement>("[data-testid=neighbour]")!;
    const motion = neighbour.animate(
      [{ transform: "translate(100px, 0)" }, { transform: "translate(0, 0)" }],
      { duration: 60_000 },
    );
    const before = commits.length;
    pane(screen.container).style.width = "700px";
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await act(() => vi.runOnlyPendingTimers());
    expect(commits.length).toBe(before);
    motion.finish();
    await vi.waitFor(() => expect(commits.at(-1)).toBe("comfortable"));
  });
});
