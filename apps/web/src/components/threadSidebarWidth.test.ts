import { assert, describe, it } from "vite-plus/test";

import { resolveInitialThreadSidebarWidth } from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("opens at the 288px default rail", () => {
    assert.equal(resolveInitialThreadSidebarWidth(null, 1600), 288);
  });

  it("keeps a stored width and clamps it to the viewport", () => {
    assert.equal(resolveInitialThreadSidebarWidth(400, 1600), 400);
    assert.equal(resolveInitialThreadSidebarWidth(400, 700), 240);
  });
});
