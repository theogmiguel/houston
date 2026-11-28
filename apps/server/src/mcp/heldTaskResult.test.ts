import { assert, describe, it } from "@effect/vitest";

import { returnsHeldTaskAtOnce } from "./heldTaskResult.ts";

describe("returnsHeldTaskAtOnce", () => {
  it("returns only a held queued task at once", () => {
    assert.isTrue(returnsHeldTaskAtOnce({ status: "queued", queuedReason: "held" }));
    assert.isFalse(returnsHeldTaskAtOnce({ status: "queued" }));
    assert.isFalse(returnsHeldTaskAtOnce({ status: "running" }));
  });
});
