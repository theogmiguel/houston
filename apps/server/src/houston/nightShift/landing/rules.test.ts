import { describe, expect, it } from "vite-plus/test";

import { verifyGate } from "./rules.ts";

describe("night shift landing rules", () => {
  it("the verify gate needs a passing verdict for every claim", () => {
    const claims = [
      { plan: 1, claim: 0 },
      { plan: 1, claim: 1 },
      { plan: 2, claim: 0 },
    ];
    const pass = (plan: number, claim: number) => ({ plan, claim, passed: true });
    expect(verifyGate({ claims, verdicts: [pass(1, 0), pass(1, 1), pass(2, 0)] })).toBe("passed");
    expect(verifyGate({ claims, verdicts: [pass(1, 0), pass(2, 0)] })).toBe("pending");
    // One failing verdict fails the gate even with every other claim passing.
    expect(
      verifyGate({
        claims,
        verdicts: [pass(1, 0), pass(1, 1), pass(2, 0), { plan: 1, claim: 1, passed: false }],
      }),
    ).toBe("failed");
    expect(verifyGate({ claims, verdicts: [] })).toBe("pending");
  });
});
