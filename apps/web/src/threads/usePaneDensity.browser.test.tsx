import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
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
      data-testid="pane"
      style={{ width: 1000, height: 600 }}
    />
  );
}

describe("usePaneDensity", () => {
  it("re-tiers a pane whose thread count changes in the same render, not a second one", async () => {
    const renders: string[] = [];
    const view = (threadCount: number) => (
      <CountedProbe threadCount={threadCount} onRender={(density) => renders.push(density)} />
    );
    await using screen = await render(view(2));
    await vi.waitFor(() => expect(renders.at(-1)).toBe("comfortable"));
    const before = renders.length;
    await screen.rerender(view(1));
    // A fill changes the pane's thread count; re-rendering its whole chat twice is the delay.
    expect(renders.slice(before)).toEqual(["solo"]);
  });

  it("re-tiers after a resize settles", async () => {
    const commits: string[] = [];
    await using screen = await render(<Probe onCommit={(density) => commits.push(density)} />);
    expect(commits.at(-1)).toBe("glance");
    pane(screen.container).style.width = "700px";
    await vi.waitFor(() => expect(commits.at(-1)).toBe("comfortable"));
  });
});
