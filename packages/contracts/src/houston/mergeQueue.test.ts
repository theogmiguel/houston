import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HoustonMergeQueueFailureKind,
  HoustonMergeQueueGateKind,
  HoustonMergeQueueGateState,
  HoustonMergeQueueHandOff,
  HoustonMergeQueueLogKind,
  HoustonMergeQueueMergeHeadInput,
  HoustonMergeQueueSettingsSetInput,
  HoustonMergeQueueStatus,
} from "./mergeQueue.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

const ENUMERATIONS: ReadonlyArray<readonly [string, Schema.Top, ReadonlyArray<string>]> = [
  [
    "status",
    HoustonMergeQueueStatus,
    ["ready", "waitingForSlot", "verifying", "blocked", "paused", "watching", "fixing", "parked"],
  ],
  [
    "gate kind",
    HoustonMergeQueueGateKind,
    ["mergeable", "reviewThreads", "reviewer", "verification"],
  ],
  ["gate state", HoustonMergeQueueGateState, ["passed", "failed", "pending", "notApplicable"]],
  [
    "failure kind",
    HoustonMergeQueueFailureKind,
    ["conflict", "failed", "timedOut", "refused", "checksFailed", "ejected"],
  ],
  ["hand-off", HoustonMergeQueueHandOff, ["houston", "autoMerge", "mergeQueue"]],
  [
    "log kind",
    HoustonMergeQueueLogKind,
    ["push", "merge", "park", "restack", "retarget", "hand_off"],
  ],
];

const settings = (patch: Record<string, unknown> = {}) => ({
  projectId: "p",
  mergeWhenVerified: false,
  verificationCommand: "pnpm test",
  timeLimitMinutes: 30,
  ...patch,
});

describe("merge queue schemas bound their fields and enumerations", () => {
  it("each enumeration decodes exactly its members", () => {
    for (const [name, schema, members] of ENUMERATIONS) {
      for (const member of members) expect(accepts(schema, member), `${name} ${member}`).toBe(true);
      for (const other of ["", "Ready", "merged", "other", "hand-off"]) {
        expect(accepts(schema, other), `${name} refuses ${other}`).toBe(false);
      }
    }
    expect(ENUMERATIONS.map(([, , members]) => members.length)).toEqual([8, 4, 4, 6, 3, 6]);
  });

  it("expectedHeadSha decodes only 40 hex digits", () => {
    const merge = (sha: unknown) =>
      accepts(HoustonMergeQueueMergeHeadInput, { projectId: "p", number: 7, expectedHeadSha: sha });
    expect(merge("a".repeat(40))).toBe(true);
    expect(merge("0123456789ABCDEF0123456789abcdef01234567")).toBe(true);
    expect(merge("abc")).toBe(false);
    expect(merge("a".repeat(39))).toBe(false);
    expect(merge("a".repeat(41))).toBe(false);
    expect(merge(`${"a".repeat(39)}g`)).toBe(false);
    expect(merge(7)).toBe(false);
  });

  it("settings refuse a command over 1,024 bytes and a limit outside 1-240", () => {
    expect(accepts(HoustonMergeQueueSettingsSetInput, settings())).toBe(true);
    expect(
      accepts(
        HoustonMergeQueueSettingsSetInput,
        settings({ verificationCommand: "x".repeat(1_024) }),
      ),
    ).toBe(true);
    expect(
      accepts(
        HoustonMergeQueueSettingsSetInput,
        settings({ verificationCommand: "x".repeat(1_025) }),
      ),
    ).toBe(false);
    // Bytes, not characters: 342 three-byte characters are 1,026 bytes.
    expect(
      accepts(
        HoustonMergeQueueSettingsSetInput,
        settings({ verificationCommand: "€".repeat(342) }),
      ),
    ).toBe(false);
    for (const minutes of [1, 30, 240]) {
      expect(
        accepts(HoustonMergeQueueSettingsSetInput, settings({ timeLimitMinutes: minutes })),
      ).toBe(true);
    }
    for (const minutes of [0, 241, 1.5, -1]) {
      expect(
        accepts(HoustonMergeQueueSettingsSetInput, settings({ timeLimitMinutes: minutes })),
      ).toBe(false);
    }
  });
});
