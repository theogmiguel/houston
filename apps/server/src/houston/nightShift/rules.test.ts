import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import type { HoustonNightShiftSettings } from "@t3tools/contracts/houston/nightShift";
import { describe, expect, it } from "vite-plus/test";

import { defaultSettings, idleDecision, validateSettings, validateWindow } from "./rules.ts";

const model = (instance: string, name = "m"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: name,
});

const drivers = new Map<string, string>([
  ["claudeAgent", "claudeAgent"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["antigravity", "antigravity"],
  ["acp", "acpRegistry"],
]);

const base: HoustonNightShiftSettings = defaultSettings({
  orchestrator: model("claudeAgent"),
  checks: [{ command: "pnpm lint", source: "ci.yml · checks" }],
  startCommand: { command: "pnpm run dev", source: "package.json" },
});

const context = { start: "23:30", drivers, mergeQueueVerification: "pnpm test" as string | null };

const refusal = (settings: HoustonNightShiftSettings, ctx = context) =>
  validateSettings(settings, ctx);

describe("night shift rules", () => {
  it("the window keeps wrap-up inside it and lasts at most 16 hours", () => {
    expect(validateWindow({ start: "23:30", wrapUp: "06:45", hardStop: "07:30" })).toEqual({
      ok: true,
      minutes: 8 * 60,
    });

    const after = validateWindow({ start: "23:30", wrapUp: "07:30", hardStop: "06:45" });
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.message).toContain("23:30");
      expect(after.message).toContain("07:30");
      expect(after.message).toContain("06:45");
    }

    const wrapped = validateWindow({ start: "07:00", wrapUp: "07:30", hardStop: "06:59" });
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok) {
      expect(wrapped.message).toContain("23 h 59 min");
      expect(wrapped.message).toContain("16 h");
      expect(wrapped.message).toContain("07:00");
      expect(wrapped.message).toContain("06:59");
    }

    const long = validateWindow({ start: "22:00", wrapUp: "05:00", hardStop: "14:01" });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain("16 h");

    // Exactly 16 hours is allowed.
    expect(validateWindow({ start: "22:00", wrapUp: "05:00", hardStop: "14:00" })).toEqual({
      ok: true,
      minutes: 16 * 60,
    });
    expect(validateWindow({ start: "22:00", wrapUp: "22:00", hardStop: "06:00" }).ok).toBe(false);

    // The window is checked by the settings rule with the task's start.
    const settingsRefusal = refusal({
      ...base,
      window: { wrapUp: "07:30", hardStop: "06:45" },
    });
    expect(settingsRefusal?.kind).toBe("invalid");
  });

  it("settings refusals name the field the bound and the value", () => {
    expect(refusal(base)).toBeNull();
    expect(base).toMatchObject({
      v: 3,
      window: { wrapUp: "06:45", hardStop: "07:30" },
      focus: {
        reliability: "normal",
        performance: "normal",
        uiPolish: "off",
        competitorGaps: "off",
        docsAccuracy: "off",
        testGaps: "off",
      },
      workers: [model("claudeAgent")],
      liveWorkers: 4,
      reviewer: null,
      backlog: { enabled: false, max: 3 },
      output: "prs",
      prSize: { kind: "related", maxChanges: 5 },
      screenshots: true,
      holdForQa: true,
      verification: "light",
      questions: "park",
      appQa: { enabled: false, startCommand: "pnpm run dev", source: "package.json" },
    });

    const cases: ReadonlyArray<
      readonly [string, HoustonNightShiftSettings, string, ReadonlyArray<string>, typeof context?]
    > = [
      [
        "antigravity worker",
        { ...base, workers: [model("antigravity")] },
        "unsupported",
        ["antigravity", "reports no usage limit"],
      ],
      [
        "antigravity orchestrator",
        { ...base, orchestrator: model("antigravity") },
        "unsupported",
        ["antigravity", "reports no usage limit"],
      ],
      ["acp orchestrator", { ...base, orchestrator: model("acp") }, "unsupported", ["acpRegistry"]],
      [
        "merge queue without verification",
        {
          ...base,
          output: "mergeQueue",
          appQa: { ...base.appQa, enabled: true },
        },
        "invalid",
        ["verification command"],
        { ...context, mergeQueueVerification: null },
      ],
      ["merge queue with App QA off", { ...base, output: "mergeQueue" }, "invalid", ["App QA"]],
      [
        "merge queue without a start command",
        {
          ...base,
          output: "mergeQueue",
          appQa: { ...base.appQa, enabled: true, startCommand: null },
        },
        "invalid",
        ["start command"],
      ],
      [
        "polish without screenshots",
        { ...base, focus: { ...base.focus, uiPolish: "low" }, screenshots: false },
        "invalid",
        ["UI and UX polish", "screenshots"],
      ],
      ["13 live workers", { ...base, liveWorkers: 13 }, "limit", ["liveWorkers", "1-12", "13"]],
      [
        "5 workers",
        {
          ...base,
          workers: [
            model("claudeAgent"),
            model("codex"),
            model("opencode"),
            model("claudeAgent", "b"),
            model("codex", "b"),
          ],
        },
        "limit",
        ["workers", "1-4", "5"],
      ],
      [
        "21 checks",
        {
          ...base,
          checks: Array.from({ length: 21 }, (_, index) => ({
            command: `pnpm run check${index}`,
            source: "package.json",
          })),
        },
        "limit",
        ["checks", "20", "21"],
      ],
      [
        "a two-line check",
        { ...base, checks: [{ command: "pnpm lint\npnpm fmt", source: "x" }] },
        "invalid",
        ["checks[0]", "one line"],
      ],
      [
        "a 1,025-byte check",
        { ...base, checks: [{ command: "x".repeat(1_025), source: "x" }] },
        "limit",
        ["checks[0]", "1024", "1025"],
      ],
      [
        "11 competitors",
        {
          ...base,
          competitors: Array.from({ length: 11 }, (_, index) => ({ repo: `owner/repo${index}` })),
        },
        "limit",
        ["competitors", "10", "11"],
      ],
      [
        "a competitor without a repository",
        { ...base, competitors: [{ repo: "owner" }] },
        "invalid",
        ["competitors[0]", "owner/repo", "owner"],
      ],
      [
        "related size 21",
        { ...base, prSize: { kind: "related", maxChanges: 21 } },
        "limit",
        ["prSize.maxChanges", "2-20", "21"],
      ],
      [
        "backlog max 11",
        { ...base, backlog: { enabled: true, max: 11 } },
        "limit",
        ["backlog.max", "1-10", "11"],
      ],
      [
        "24,001 characters of text",
        {
          ...base,
          checks: [],
          direction: "x",
          appQa: {
            ...base.appQa,
            startCommand: null,
            source: null,
            address: null,
            smokeFlows: Array.from({ length: 20 }, () => "y".repeat(1_200)),
          },
        },
        "limit",
        ["text", "24000", "24001"],
      ],
      [
        "a 2,001-character direction",
        { ...base, direction: "d".repeat(2_001) },
        "limit",
        ["direction", "2000", "2001"],
      ],
    ];
    for (const [name, settings, kind, names, ctx] of cases) {
      const result = refusal(settings, ctx ?? context);
      expect(result, name).not.toBeNull();
      expect(result?.kind, name).toBe(kind);
      for (const text of names) expect(result?.message, `${name}: ${text}`).toContain(text);
    }

    // A bound exactly at its limit is accepted.
    expect(refusal({ ...base, liveWorkers: 12 })).toBeNull();
    expect(refusal({ ...base, liveWorkers: 0 })?.kind).toBe("limit");
    expect(refusal({ ...base, checks: [{ command: "x".repeat(1_024), source: "x" }] })).toBeNull();
    expect(refusal({ ...base, workers: [] })?.kind).toBe("limit");
  });

  it("the idle rule nudges once then settles", () => {
    const minute = 60_000;
    // Idle since 0.
    expect(idleDecision({ idleSinceMs: 0, nudgedAtMs: null, nowMs: 9 * minute })).toBe("none");
    expect(idleDecision({ idleSinceMs: 0, nudgedAtMs: null, nowMs: 10 * minute })).toBe("nudge");
    // A live crew member or a running orchestrator: not idle.
    expect(idleDecision({ idleSinceMs: null, nudgedAtMs: null, nowMs: 30 * minute })).toBe("none");
    // Woken at 15, idle again from 16: no second nudge, settle at 26.
    expect(
      idleDecision({ idleSinceMs: 16 * minute, nudgedAtMs: 10 * minute, nowMs: 20 * minute }),
    ).toBe("none");
    expect(
      idleDecision({
        idleSinceMs: 16 * minute,
        nudgedAtMs: 10 * minute,
        nowMs: 25 * minute + 59_000,
      }),
    ).toBe("none");
    expect(
      idleDecision({ idleSinceMs: 16 * minute, nudgedAtMs: 10 * minute, nowMs: 26 * minute }),
    ).toBe("settle");
    // Still idle after the nudge: settle 10 minutes after it.
    expect(idleDecision({ idleSinceMs: 0, nudgedAtMs: 10 * minute, nowMs: 19 * minute })).toBe(
      "none",
    );
    expect(idleDecision({ idleSinceMs: 0, nudgedAtMs: 10 * minute, nowMs: 20 * minute })).toBe(
      "settle",
    );
  });
});
