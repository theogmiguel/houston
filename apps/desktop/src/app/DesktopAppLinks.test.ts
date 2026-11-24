import { assert, describe, it } from "@effect/vitest";

import { shouldHandleSecondInstance } from "./DesktopAppLinks.ts";

describe("second instance handling", () => {
  it("does nothing while the app quits for an update, so the relaunch is not fought", () => {
    assert.isFalse(shouldHandleSecondInstance(true));
  });

  it("focuses and opens the launch targets otherwise", () => {
    assert.isTrue(shouldHandleSecondInstance(false));
  });
});
