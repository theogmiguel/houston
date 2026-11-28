import { assert, describe, it } from "@effect/vitest";

import { STOPPED_THREAD_HOLD_MESSAGE, stoppedThreadAdmission } from "./StoppedThreadAdmission.ts";

const input = (overrides: Partial<Parameters<typeof stoppedThreadAdmission>[0]> = {}) => ({
  origin: "automatic" as const,
  holdAgentMessagesAfterStop: true,
  thread: { heldAfterStop: true },
  ...overrides,
});

describe("stoppedThreadAdmission", () => {
  it("holds an automatic start after the user pressed Stop", () => {
    const hold = stoppedThreadAdmission(input());
    assert.deepEqual(hold, {
      type: "hold",
      releaseAt: null,
      reason: { kind: "stopped_thread", message: STOPPED_THREAD_HOLD_MESSAGE },
    });
  });

  it("never holds a user or provider start", () => {
    assert.isNull(stoppedThreadAdmission(input({ origin: "user" })));
    assert.isNull(stoppedThreadAdmission(input({ origin: "provider" })));
    assert.isNull(stoppedThreadAdmission(input({ origin: "maintenance" })));
  });

  it("does not hold when the setting is off", () => {
    assert.isNull(stoppedThreadAdmission(input({ holdAgentMessagesAfterStop: false })));
  });

  it("does not hold a thread the user has not stopped", () => {
    assert.isNull(stoppedThreadAdmission(input({ thread: { heldAfterStop: false } })));
    assert.isNull(stoppedThreadAdmission(input({ thread: {} })));
  });
});
