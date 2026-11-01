// The landing rules that decide an outcome without I/O, starting with the Verify gate.
import type { NightGateState } from "@t3tools/contracts/houston/nightShift";

export interface ClaimRef {
  /** The plan entry's id. */
  readonly plan: number;
  /** The claim's index in that plan, from 0. */
  readonly claim: number;
}

/**
 * The Verify gate of a pull request: failed on any failing verdict, passed when every claim of
 * its plans has a passing verdict, pending otherwise (no claims to verify is pending too).
 */
export const verifyGate = (input: {
  readonly claims: ReadonlyArray<ClaimRef>;
  readonly verdicts: ReadonlyArray<ClaimRef & { readonly passed: boolean }>;
}): NightGateState => {
  if (input.verdicts.some((verdict) => !verdict.passed)) return "failed";
  if (input.claims.length === 0) return "pending";
  const passed = new Set(input.verdicts.map((verdict) => `${verdict.plan}:${verdict.claim}`));
  return input.claims.every((claim) => passed.has(`${claim.plan}:${claim.claim}`))
    ? "passed"
    : "pending";
};
