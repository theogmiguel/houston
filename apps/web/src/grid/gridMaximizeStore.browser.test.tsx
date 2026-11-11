import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useGridMaximizeStore, useLeaveGridMaximize } from "./gridMaximizeStore";

function GridProbe({ gridId, seen }: { gridId: string; seen: Array<string | null> }) {
  useLeaveGridMaximize(gridId);
  seen.push(useGridMaximizeStore((store) => store.maximizedThreadIdByGrid[gridId] ?? null));
  return null;
}

describe("useLeaveGridMaximize", () => {
  it("shows a grid left with a maximized cell as a grid from its first frame back", async () => {
    const seen: Array<string | null> = [];
    const first = await render(<GridProbe gridId="g-1" seen={seen} />, { router: false });
    await act(() => useGridMaximizeStore.getState().setMaximizedThreadId("g-1", "thread-a"));
    expect(seen.at(-1)).toBe("thread-a");
    await first[Symbol.asyncDispose]();

    seen.length = 0;
    await using _back = await render(<GridProbe gridId="g-1" seen={seen} />, { router: false });
    // Clearing it after paint would show the solo thread, then replay the restore morph.
    expect(seen[0]).toBeNull();
  });
});
