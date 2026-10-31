import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HoustonHarnessDecisionState,
  HoustonHarnessDefectDecision,
  HoustonHarnessDefectDestination,
  HoustonHarnessDefectSource,
  HoustonHarnessFindingPhase,
  HoustonHarnessReviewStatus,
  HoustonHarnessSchedule,
  HoustonHarnessSetupInput,
  HoustonHarnessVerdict,
} from "./harnessReview.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

describe("harness review schemas", () => {
  it("harness review schemas bound their enumerations", () => {
    const enumerations: ReadonlyArray<readonly [string, Schema.Top, ReadonlyArray<string>]> = [
      [
        "review status",
        HoustonHarnessReviewStatus,
        ["preparing", "running", "published", "failed"],
      ],
      [
        "phase",
        HoustonHarnessFindingPhase,
        ["open", "fixing", "awaitingVerification", "notSeen", "resolved", "dismissed"],
      ],
      ["state", HoustonHarnessDecisionState, ["open", "dismissed", "resolved"]],
      ["verdict", HoustonHarnessVerdict, ["gone", "stillPresent", "inconclusive"]],
      ["defect source", HoustonHarnessDefectSource, ["agent", "detector"]],
      ["destination", HoustonHarnessDefectDestination, ["houston", "project"]],
      ["defect decision", HoustonHarnessDefectDecision, ["dismiss", "notABug", "reopen"]],
      ["schedule", HoustonHarnessSchedule, ["weekly", "daily", "manual"]],
    ];
    const counts = enumerations.map(([, , values]) => values.length);
    expect(counts).toEqual([4, 6, 3, 3, 2, 2, 3, 3]);
    for (const [name, schema, values] of enumerations) {
      for (const value of values) expect(accepts(schema, value), `${name} ${value}`).toBe(true);
      for (const value of ["", "other", "still_present", "workspace", "Weekly", 1, null]) {
        expect(accepts(schema, value), `${name} ${String(value)}`).toBe(false);
      }
    }
    const setup = {
      projectId: "project:p",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
      schedule: "weekly",
    };
    expect(accepts(HoustonHarnessSetupInput, setup)).toBe(true);
    expect(accepts(HoustonHarnessSetupInput, { ...setup, schedule: "hourly" })).toBe(false);
  });
});
