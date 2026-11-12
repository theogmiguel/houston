import { describe, expect, it } from "vite-plus/test";

import { notePaneDrop, takePaneDrop } from "./paneDrop";

describe("paneDrop", () => {
  it("reports a noted drop once, then clears", () => {
    notePaneDrop(true);
    expect(takePaneDrop()).toBe(true);
    expect(takePaneDrop()).toBe(false);
  });

  it("forgets a drop the layout did not take", () => {
    notePaneDrop(true);
    notePaneDrop(false);
    expect(takePaneDrop()).toBe(false);
  });
});
