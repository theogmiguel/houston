import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HoustonNightShiftSettings,
  NightCrewRole,
  NightEntryKind,
  NightFocusLevel,
  NightGateState,
  NightOutput,
  NightPreflightStatus,
  NightRunPhase,
  NightRunTrigger,
  NightStopReason,
  NightVerification,
  NightPullRequestSize,
} from "./nightShift.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

const model = { instanceId: "claudeAgent", model: "claude-opus-4-6" };

export const validSettings = {
  v: 3,
  enabled: true,
  window: { wrapUp: "06:45", hardStop: "07:30" },
  focus: {
    reliability: "normal",
    performance: "normal",
    uiPolish: "off",
    competitorGaps: "off",
    docsAccuracy: "off",
    testGaps: "off",
  },
  direction: "",
  competitors: [],
  orchestrator: model,
  workers: [model],
  liveWorkers: 4,
  reviewer: null,
  backlog: { enabled: false, max: 3 },
  output: "prs",
  prSize: { kind: "related", maxChanges: 5 },
  screenshots: true,
  appQa: { enabled: false, startCommand: null, source: null, address: null, smokeFlows: [] },
  holdForQa: true,
  checks: [{ command: "pnpm lint", source: "ci.yml · checks" }],
  verification: "light",
  questions: "park",
};

describe("night shift schemas", () => {
  it("night shift schemas bound their enumerations", () => {
    const enumerations: ReadonlyArray<readonly [string, Schema.Top, ReadonlyArray<string>]> = [
      ["phase", NightRunPhase, ["preflight", "refused", "running", "wrappingUp", "settled"]],
      ["trigger", NightRunTrigger, ["scheduled", "catchUp", "manual", "imported"]],
      [
        "stop reason",
        NightStopReason,
        [
          "report",
          "hardStop",
          "stopped",
          "idle",
          "orchestratorEnded",
          "orchestratorLimited",
          "serverRestart",
          "launchFailed",
          "imported",
        ],
      ],
      [
        "crew role",
        NightCrewRole,
        ["orchestrator", "implementation", "research", "review", "design", "test", "general"],
      ],
      [
        "entry kind",
        NightEntryKind,
        ["plan", "pr", "lesson", "flaky", "decision", "deferred", "studied", "pick", "verdict"],
      ],
      ["gate state", NightGateState, ["passed", "failed", "pending", "notApplicable"]],
      ["preflight status", NightPreflightStatus, ["ok", "warn", "block"]],
      ["focus level", NightFocusLevel, ["off", "low", "normal", "high"]],
      ["output", NightOutput, ["prs", "mergeQueue"]],
      ["verification", NightVerification, ["light", "standard"]],
    ];
    expect(enumerations.map(([, , values]) => values.length)).toEqual([
      5, 4, 9, 7, 9, 4, 3, 4, 2, 2,
    ]);
    for (const [name, schema, values] of enumerations) {
      for (const value of values) expect(accepts(schema, value), `${name} ${value}`).toBe(true);
      for (const value of ["", "other", "Running", "wrapping_up", "high ", 1, null]) {
        expect(accepts(schema, value), `${name} ${String(value)}`).toBe(false);
      }
    }

    expect(accepts(NightPullRequestSize, { kind: "one" })).toBe(true);
    expect(accepts(NightPullRequestSize, { kind: "related", maxChanges: 5 })).toBe(true);
    expect(accepts(NightPullRequestSize, { kind: "several" })).toBe(false);
    expect(accepts(NightPullRequestSize, { kind: "related" })).toBe(false);

    expect(accepts(HoustonNightShiftSettings, validSettings)).toBe(true);
    for (const v of [2, 4, "3", undefined]) {
      expect(accepts(HoustonNightShiftSettings, { ...validSettings, v }), `v ${String(v)}`).toBe(
        false,
      );
    }
    expect(
      accepts(HoustonNightShiftSettings, {
        ...validSettings,
        focus: { ...validSettings.focus, uiPolish: "max" },
      }),
    ).toBe(false);
    expect(accepts(HoustonNightShiftSettings, { ...validSettings, questions: "ask" })).toBe(false);
  });
});
